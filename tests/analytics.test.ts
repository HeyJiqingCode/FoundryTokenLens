import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { csvCell } from '../src/server/analytics/routes.js';
import { moneyUnits } from '../src/server/pricing/money.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import {
  SyntheticBlobReader,
  containers,
  path,
  usage,
  response,
  now,
} from './fixtures/diagnostics.js';

test('analytics weights cache by tokens and computes P95 from requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-analytics-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  settings.saveSource(
    { authMode: 'connection_string', containers },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://synthetic.blob.core.windows.net',
      accountName: 'synthetic',
      containers: [...LOG_CONTAINERS],
      verifiedAt: now.toISOString(),
    },
    'test',
  );
  const reader = new SyntheticBlobReader();
  const usages = Array.from({ length: 20 }, (_, i) =>
    usage(`r${i}`, {
      modelName: i === 19 ? 'other-model' : 'synthetic-model',
      promptTokens: i === 19 ? 900 : 100,
      cachedTokens: i === 19 ? 450 : 10,
      generatedTokens: i === 19 ? 100 : 20,
    }),
  );
  const responses = Array.from({ length: 20 }, (_, i) =>
    response(`r${i}`, i === 19 ? 1000 : 10, i === 19 ? 500 : 200),
  );
  reader.put(containers[0], path(), usages);
  reader.put(containers[1], path(), responses);
  const worker = createImportWorker(db, settings, () => reader);
  const pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  worker.request('scan');
  await worker.settled();
  for (const model of ['synthetic-model', 'other-model'])
    settings.addPrice(
      {
        model,
        modelVersion: '*',
        region: '*',
        deploymentType: '*',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        notes: 'synthetic',
        items: [
          { key: 'input', label: 'Input', unitQuantity: 1000, unitPriceUsd: '2' },
          { key: 'cache_read', label: 'Cache read', unitQuantity: 1000, unitPriceUsd: '0.2' },
          { key: 'output', label: 'Output', unitQuantity: 1000, unitPriceUsd: '8' },
          { key: 'cache_write', label: 'Cache write', unitQuantity: 1000, unitPriceUsd: '3' },
        ],
      },
      'test',
    );
  pricing.recalculate();
  const analytics = createAnalyticsService(db, settings);
  const all = analytics.report({});
  assert.equal(all.summary.requests, 20);
  assert.equal(all.summary.inputTokens, '2800');
  assert.equal(all.summary.cachedTokens, '640');
  assert.equal(all.summary.cacheRatio, 0.228571);
  assert.equal(all.summary.p95DurationMs, 10);
  assert.equal(all.summary.averageDurationMs, 59.5);
  assert.equal(all.summary.costUsd, '8.288');
  assert.equal(all.summary.cacheWriteTokens, null);
  assert.equal(all.summary.averageCostUsd, '0.4144');
  assert.equal(all.summary.p95CostUsd, '0.342');
  assert.deepEqual(all.stacks?.model.map((group) => group.name).sort(), [
    'other-model',
    'synthetic-model',
  ]);
  for (const by of ['model', 'resource'] as const)
    all.timeline.forEach((bucket, i) => {
      const points = all.stacks![by].flatMap((group) => group.points.filter((p) => p.i === i));
      assert.equal(
        points.reduce((sum, p) => sum + p.requests, 0),
        bucket.requests,
        `${by} requests`,
      );
      assert.equal(
        points.reduce((sum, p) => sum + p.errors, 0),
        bucket.errors,
        `${by} errors`,
      );
      for (const key of ['inputTokens', 'outputTokens', 'cachedTokens'] as const)
        assert.equal(
          points.reduce((sum, p) => sum + BigInt(p[key] ?? 0), 0n),
          BigInt(bucket[key] ?? 0),
          `${by} ${key}`,
        );
      assert.equal(
        points.reduce((sum, p) => sum + moneyUnits(p.costUsd ?? '0'), 0n),
        moneyUnits(bucket.costUsd ?? '0'),
        `${by} cost`,
      );
    });
  assert.equal(analytics.report({ status: 'error' }).summary.requests, 1);
  assert.equal(analytics.report({ status: 'ok' }).summary.requests, 19);
  assert.equal(analytics.requests({ status: 'error' }, 25).total, 1);
  assert.equal(analytics.report({ model: 'other-model' }).summary.requests, 1);
  assert.equal(analytics.requests({ model: 'other-model' }, 25).total, 1);
  assert.equal(
    analytics.report({ to: now.toISOString() }).summary.requests,
    0,
    'time range is half open',
  );
  const supplemented = usage('r0', {
    modelName: 'synthetic-model',
    promptTokens: 100,
    cachedTokens: 10,
    generatedTokens: 20,
    cacheWriteTokens: 50,
  });
  reader.put(containers[0], path(), [...usages, supplemented]);
  worker.request('scan');
  await worker.settled();
  pricing.recalculate();
  const updated = analytics.report({});
  assert.equal(updated.summary.requests, 20);
  assert.equal(updated.summary.inputTokens, '2800');
  assert.equal(updated.summary.cachedTokens, '640');
  assert.equal(updated.summary.cacheWriteTokens, '50');
  assert.equal(updated.summary.costUsd, '8.338');
  assert.equal(updated.summary.averageCostUsd, '0.4169');
  assert.equal(updated.summary.p95CostUsd, '0.392');
});

test('CSV cells preserve quoting and neutralize spreadsheet formulas', () => {
  assert.equal(csvCell('=SUM(A1:A9)'), '"\'=SUM(A1:A9)"');
  assert.equal(csvCell('  @bad'), '"\'  @bad"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell(null), '""');
});

test('models without a computed price stay hidden from views until pricing covers them', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-priced-models-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  settings.saveSource(
    { authMode: 'connection_string', containers },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://synthetic.blob.core.windows.net',
      accountName: 'synthetic',
      containers: [...LOG_CONTAINERS],
      verifiedAt: now.toISOString(),
    },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.put(containers[0], path(), [
    usage('priced', { modelName: 'priced-model' }),
    usage('later', { modelName: 'later-model' }),
    usage('throttled', { modelName: 'later-model' }),
  ]);
  reader.put(containers[1], path(), [
    response('priced'),
    response('later'),
    response('throttled', 10, 429),
  ]);
  const worker = createImportWorker(db, settings, () => reader);
  const pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  worker.request('scan');
  await worker.settled();
  const addPrice = (model: string) =>
    settings.addPrice(
      {
        model,
        modelVersion: '*',
        region: '*',
        deploymentType: '*',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        notes: 'synthetic',
        items: [{ key: 'input', label: 'Input', unitQuantity: 1000, unitPriceUsd: '2' }],
      },
      'test',
    );
  addPrice('priced-model');
  pricing.recalculate();
  const analytics = createAnalyticsService(db, settings);
  assert.deepEqual(analytics.pricedModels(), ['priced-model']);
  const visible = () => ({ pricedModels: analytics.pricedModels() });
  assert.equal(analytics.report(visible()).summary.requests, 1);
  assert.deepEqual(
    analytics.report(visible()).models.map((model) => model.name),
    ['priced-model'],
  );
  assert.equal(analytics.requests(visible()).total, 1);
  assert.deepEqual(analytics.facets(true).models, ['priced-model']);
  assert.deepEqual(analytics.report(visible()).facets.models, ['priced-model']);
  // The service itself still sees every call; only the views apply the restriction.
  assert.equal(analytics.report({}).summary.requests, 3);

  const later = addPrice('later-model');
  pricing.invalidateManual(later.model, later.validFrom, later.validTo);
  pricing.recalculate();
  assert.deepEqual(analytics.pricedModels(), ['later-model', 'priced-model']);
  assert.equal(analytics.report(visible()).summary.requests, 3, 'earlier calls return');
  assert.equal(analytics.report(visible()).summary.throttled, 1);
});

test('report cache ignores platform history writes and invalidates on monitoring changes including rollback', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-cache-')),
    db = openDatabase(dir),
    settings = createSettingsRepository(db, createSecretStore(dir));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const analytics = createAnalyticsService(db, settings),
    filter = { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' };
  const report = analytics.report(filter);
  db.connection.prepare('INSERT INTO scheduler_state VALUES(1,?)').run('2026-09-01T00:00:00Z');
  assert.strictEqual(analytics.report(filter), report);
  db.connection
    .prepare('INSERT INTO request_facts VALUES(?,?,?,?,?,?,?,?)')
    .run('x', 'r', 'c', '2026-09-01T00:00:00Z', 1, '{}', null, null);
  const next = analytics.report(filter);
  assert.notStrictEqual(next, report);
  assert.throws(() =>
    db.connection.transaction(() => {
      db.connection.prepare('DELETE FROM request_facts').run();
      throw Error('rollback');
    })(),
  );
  assert.strictEqual(analytics.report(filter), next);
});
