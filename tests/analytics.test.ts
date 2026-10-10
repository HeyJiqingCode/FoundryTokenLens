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
import {
  createAnalyticsService,
  lowestCache,
  monthForecast,
} from '../src/server/analytics/service.js';
import { csvCell } from '../src/server/analytics/routes.js';
import { moneyUnits } from '../src/server/pricing/money.js';
import { accumulator } from '../src/server/analytics/aggregate.js';
import { BINNED_MEASURES } from '../src/shared/analytics.js';
import type { RequestFact } from '../src/shared/ingestion.js';
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
  assert.equal(all.slowest?.duration.length, 19);
  // Each resource's models add up to the resource: overall, in every bucket and in every bin.
  for (const resource of all.resources) {
    const pairs = (rows: { resource: string }[] | undefined) =>
      (rows ?? []).filter((row) => row.resource === resource.name);
    const models = pairs(all.resourceModels) as NonNullable<typeof all.resourceModels>;
    assert.equal(
      models.reduce((sum, row) => sum + row.requests, 0),
      resource.requests,
    );
    const stacked = pairs(all.stacks?.pairs) as NonNullable<
      NonNullable<typeof all.stacks>['pairs']
    >;
    for (const point of all.stacks!.resource.find((g) => g.name === resource.name)!.points)
      assert.equal(
        stacked.reduce(
          (sum, pair) => sum + (pair.points.find((p) => p.i === point.i)?.requests ?? 0),
          0,
        ),
        point.requests,
      );
    const binned = pairs(all.measureBins?.pairs) as NonNullable<
      NonNullable<typeof all.measureBins>['pairs']
    >;
    const bins = all.measureBins!.resource.find((g) => g.name === resource.name)!;
    for (const measure of BINNED_MEASURES)
      bins.counts[measure].forEach((count, i) =>
        assert.equal(
          binned.reduce((sum, pair) => sum + pair.counts[measure][i], 0),
          count,
        ),
      );
  }
  // Every call here has under 1,024 input tokens, so none ranks by cache hit rate.
  assert.deepEqual(all.lowestCache, { nonZero: [], zero: [] });
  // The failed call (r19) is not among them.
  assert.ok(all.slowest?.duration.every((row) => row.correlationId !== 'r19'));
  assert.equal(
    all.distributions?.duration.reduce((sum, bin) => sum + bin.count, 0),
    19,
  );
  // Split distributions add up to the whole one, bin by bin.
  for (const by of ['model', 'resource'] as const)
    for (const measure of BINNED_MEASURES)
      all.distributions![measure].forEach((bin, i) =>
        assert.equal(
          all.measureBins![by].reduce((sum, group) => sum + group.counts[measure][i], 0),
          bin.count,
          `${by} ${measure} bin ${i}`,
        ),
      );
  assert.equal(
    all.stacks?.model.find((g) => g.name === 'other-model')?.points[0].p95DurationMs,
    null,
  );
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

test('time measures count only successful calls; speed needs enough output and a generation span', () => {
  const fact = (
    statusCode: number,
    durationMs: number,
    timeToFirstTokenMs: number,
    timeToLastTokenMs: number,
    outputTokens = '200',
  ) =>
    ({
      hasRequest: true,
      hasUsage: true,
      statusCode,
      statusConflict: false,
      durationMs,
      timeToFirstTokenMs,
      timeToLastTokenMs,
      inputTokens: '10',
      outputTokens,
      cachedTokens: null,
      cacheWriteTokens: null,
      cost: null,
    }) as unknown as RequestFact;
  const summary = accumulator();
  summary.add(fact(200, 3000, 1000, 3000)); // 200 tokens in 2 s: 100 per second
  summary.add(fact(200, 5000, 1000, 5000)); // 50 per second
  summary.add(fact(200, 2000, 500, 600, '50')); // 500 per second, from too few tokens to count
  summary.add(fact(200, 1000, 800, 800)); // no time between first and last token
  // Failed calls count for none of the time measures, though both generate 2000 tokens a second.
  summary.add(fact(500, 90000, 80000, 80100));
  summary.add(fact(429, 300, 100, 200));
  const result = summary.result();
  assert.equal(result.errors, 2);
  assert.equal(result.p50DurationMs, 2000);
  assert.equal(result.p95DurationMs, 5000);
  assert.equal(result.p95FirstTokenMs, 1000);
  assert.equal(result.p50LastTokenMs, 800);
  assert.equal(result.p95LastTokenMs, 5000);
  assert.equal(result.p50TokensPerSecond, 50);
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

test('lowest cache hit rates rank calls from 1,024 input tokens, zero rates apart, the most uncached input first among equals', () => {
  const call = (correlationId: string, inputTokens: string | null, cachedTokens: string | null) =>
    ({ correlationId, hasUsage: true, inputTokens, cachedTokens }) as RequestFact;
  const rows = [
    call('half', '2000', '1000'),
    call('quarter', '4000', '1000'),
    call('small-miss', '1024', '0'),
    call('below-floor', '1023', '0'),
    call('no-input', '0', '0'),
    call('large-miss', '50000', '0'),
    call('no-cache-field', '3000', null),
    { ...call('no-usage', '4000', '0'), hasUsage: false },
  ];
  const ranked = lowestCache(rows);
  assert.deepEqual(
    ranked.nonZero.map((row) => row.correlationId),
    ['quarter', 'half'],
  );
  assert.deepEqual(
    ranked.zero.map((row) => row.correlationId),
    ['large-miss', 'small-miss'],
  );
});

test('cache savings price cache reads at the input rate, less what they cost, with each item cost', () => {
  const item = (key: string, unitPriceUsd: string, quantity: string, costUsd: string) => ({
    key,
    label: key,
    unitQuantity: 1000000,
    unitPriceUsd,
    quantity,
    costUsd,
    reason: null,
    reference: 'manual:test@1',
  });
  const a = accumulator();
  a.add({
    hasUsage: true,
    cost: {
      knownUsd: '0.71',
      items: [
        item('input', '2', '250000', '0.5'),
        item('cache_read', '0.2', '1000000', '0.2'),
        item('output', '10', '1000', '0.01'),
      ],
    },
  } as unknown as RequestFact);
  const result = a.result();
  // 1M cached tokens would have cost $2 as input; they cost $0.20.
  assert.equal(result.cacheSavingsUsd, '1.8');
  assert.deepEqual(result.itemCostUsd, { input: '0.5', cache_read: '0.2', output: '0.01' });
});

test('the month forecast keeps the month average daily cost from now to the month end', () => {
  const now = new Date('2026-10-10T04:00:00.000Z'); // noon on October 10 in Shanghai
  const forecast = monthForecast(
    [
      { time: '2026-08-31T15:59:59.000Z', usd: '5' }, // August 31 in Shanghai: neither month
      { time: '2026-09-15T00:00:00.000Z', usd: '10' },
      { time: '2026-09-30T16:00:00.000Z', usd: '1' }, // the first second of October
      { time: '2026-10-09T03:00:00.000Z', usd: '3' },
      { time: '2026-10-10T01:00:00.000Z', usd: '2' },
      { time: '2026-10-10T05:00:00.000Z', usd: '100' }, // after now
    ],
    now,
    'Asia/Shanghai',
  );
  assert.equal(forecast.days.length, 31);
  assert.equal(forecast.days[0], '2026-09-30T16:00:00.000Z');
  assert.equal(forecast.previous, 10);
  assert.deepEqual(forecast.actual.slice(0, 11), [1, 1, 1, 1, 1, 1, 1, 1, 4, 6, null]);
  assert.equal(forecast.forecast[8], null);
  assert.equal(forecast.forecast[9], 6);
  // $6 in 9.5 days, kept up for the whole month.
  assert.ok(Math.abs(forecast.forecast[30]! - (6 / 9.5) * 31) < 1e-9);
});
