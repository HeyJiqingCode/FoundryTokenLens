import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RequestFact } from '../src/shared/ingestion.js';
import type { PriceVersion } from '../src/shared/settings.js';
import { calculateCost } from '../src/server/pricing/engine.js';
import { decodeCatalog, decodeRate, groupRates } from '../src/server/pricing/retail.js';
import { charge, decimal } from '../src/server/pricing/money.js';
import { openDatabase } from '../src/server/database.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import {
  SyntheticBlobReader,
  containers,
  path,
  usage,
  response,
  resource,
  now,
} from './fixtures/diagnostics.js';

const fact: RequestFact = {
  resourceId: resource,
  correlationId: 'billing',
  time: now.toISOString(),
  timeSource: 'event',
  model: 'synthetic-model',
  modelVersion: 'v1',
  deployment: 'synthetic',
  region: 'East US 2',
  operation: 'create-response',
  inputTokens: '1000',
  outputTokens: '100',
  cachedTokens: '200',
  cacheWriteTokens: null,
  durationMs: 100,
  timeToFirstTokenMs: 10,
  statusCode: 200,
  callerIp: null,
  hasUsage: true,
  hasRequest: true,
};
const price: PriceVersion = {
  id: 'synthetic-manual',
  source: 'manual',
  currency: 'USD',
  revision: 1,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  model: 'synthetic-model',
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  notes: '',
  items: [
    { key: 'input', label: 'Input', unitQuantity: 1000, unitPriceUsd: '2' },
    { key: 'cache_read', label: 'Cached', unitQuantity: 1000, unitPriceUsd: '0.2' },
    { key: 'output', label: 'Output', unitQuantity: 1000, unitPriceUsd: '8' },
  ],
};
function raw(sku: string, cost: string, date = '2026-09-01T00:00:00Z') {
  return {
    currencyCode: 'USD',
    type: 'Consumption',
    tierMinimumUnits: 0,
    isPrimaryMeterRegion: true,
    productId: 'synthetic-product',
    productName: 'Synthetic GPT',
    skuName: sku,
    meterName: `${sku} 1M Tokens`,
    unitOfMeasure: '1M',
    retailPrice: cost,
    effectiveStartDate: date,
    armRegionName: 'eastus2',
    meterId: sku,
  };
}

test('manual billing uses exact decimals, effective dates, and bills each prompt token once', () => {
  assert.equal(calculateCost(fact, [price]).totalUsd, '2.44');
  assert.equal(
    calculateCost({ ...fact, time: '2026-08-31T23:59:59.999Z' }, [price]).totalUsd,
    null,
  );
  const write = {
    ...price,
    items: [
      ...price.items,
      { key: 'cache_write', label: 'Write', unitQuantity: 1000, unitPriceUsd: '2.5' },
    ],
  };
  const noWrites = calculateCost(fact, [write]);
  assert.equal(noWrites.totalUsd, '2.44');
  assert.equal(noWrites.items.find((x) => x.key === 'cache_write')?.quantity, '0');
  const known = calculateCost({ ...fact, cacheWriteTokens: '100' }, [write]);
  assert.equal(known.totalUsd, '2.49');
  assert.deepEqual(known.items.slice(1, 3), noWrites.items.slice(1, 3));
  assert.equal(known.items.find((x) => x.key === 'input')?.quantity, '700');
  assert.equal(calculateCost({ ...fact, timeSource: 'ingestion' }, [price]).status, 'missing_time');
  assert.equal(calculateCost({ ...fact, cachedTokens: null }, [price]).totalUsd, '2.8');
  assert.equal(calculateCost({ ...fact, cachedTokens: '2000' }, [price]).totalUsd, '1.2');
  assert.equal(
    charge('9223372036854775807', '0.000000000001', 1000000000),
    '0.009223372036854775807',
  );
  assert.equal(decimal('4.2e-7'), '0.00000042');
});

test('Retail catalog decoding keeps service tiers, cache writes, unrecognized meters and image modalities', () => {
  const groups = groupRates(
    decodeCatalog([
      raw('5.6 sol ShortCo Inp Std Gl', '4'),
      raw('5.6 sol ShortCo Cd Inp Std Gl', '0.4'),
      raw('5.6 sol ShortCo Cd Wr Std Gl', '5'),
      raw('5.6 sol ShortCo Opt Std Gl', '20'),
      raw('5.6 sol LongCo Inp Std Gl', '8'),
      raw('5.6 sol LongCo Opt Std Gl', '30'),
      raw('5.6 sol ShortCo Opt PP Gl', '40'),
    ]).map((x) => x.rate),
  );
  assert.equal(groups.length, 2);
  const standard = groups.find((x) => x.serviceTier === 'standard')!;
  assert.ok(standard.components.includes('cache_write'));
  assert.equal(standard.hasContextBands, true);
  const rates = decodeCatalog([raw('model Inp Std Gl', '1'), raw('model Novel Std Gl', '3')]).map(
    (x) => x.rate,
  );
  assert.equal(rates.length, 2);
  assert.equal(groupRates(rates)[0].components.length, 2);
  assert.equal(decodeRate(raw('gpt img 1.5 in img DZ', '8'))!.component, 'input_image');
});

test('billing service recalculates only the model whose price changed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-price-service-'));
  const db = openDatabase(dir);
  const settings = createSettingsRepository(db, createSecretStore(dir));
  const analytics = createAnalyticsService(db, settings);
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
  reader.put(containers[0], path(), [usage('a'), usage('b', { modelName: 'other-model' })]);
  reader.put(containers[1], path(), [response('a'), response('b')]);
  const worker = createImportWorker(db, settings, () => reader);
  const pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  worker.request('scan');
  await worker.settled();
  assert.equal(db.takeCostsDirty(), true);
  assert.equal(pricing.recalculate(), 2);
  assert.equal(pricing.recalculate(), 0);
  const saved = settings.addPrice(price, 'test');
  pricing.invalidateManual(saved.model, saved.validFrom, saved.validTo);
  assert.equal(db.takeCostsDirty(), true);
  assert.equal(pricing.recalculate(), 1);
  assert.equal(
    analytics.requests({}, 50, 0).requests.find((r) => r.correlationId === 'a')?.cost?.complete,
    true,
  );
  assert.equal(pricing.detected().length, 2);
});

test('late cacheWriteTokens joins the same request and reprices without changing other raw quantities', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-late-write-'));
  const db = openDatabase(dir);
  const settings = createSettingsRepository(db, createSecretStore(dir));
  const analytics = createAnalyticsService(db, settings);
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
  settings.addPrice(
    {
      ...price,
      items: [
        ...price.items,
        { key: 'cache_write', label: 'Write', unitQuantity: 1000, unitPriceUsd: '2.5' },
      ],
    },
    'test',
  );
  const reader = new SyntheticBlobReader();
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => now,
  );
  const pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const original = usage('late-write', {
    promptTokens: [1000],
    generatedTokens: 100,
    cachedTokens: 200,
  });
  reader.put(containers[0], path(), [original]);
  worker.request('scan');
  await worker.settled();
  assert.equal(db.takeCostsDirty(), true);
  pricing.recalculate();
  const before = analytics.requests({}, 50, 0).requests[0];
  assert.equal(before.cacheWriteTokens, null);
  assert.equal(before.cost?.totalUsd, '2.44');
  assert.equal(before.cost?.items.find((x) => x.key === 'cache_write')?.costUsd, '0');
  const supplemented = usage('late-write', {
    promptTokens: [1000],
    generatedTokens: 100,
    cachedTokens: 200,
    cacheWriteTokens: [100],
  });
  const zeroWrite = usage('zero-write', { cache_write_tokens: 0 });
  reader.put(containers[0], path(), [original, supplemented, zeroWrite]);
  worker.request('scan');
  await worker.settled();
  assert.equal(db.takeCostsDirty(), true);
  assert.equal(pricing.recalculate(), 2);
  const after = analytics
    .requests({}, 50, 0)
    .requests.find((x) => x.correlationId === 'late-write')!;
  assert.equal(after.cacheWriteTokens, '100');
  assert.equal(after.cost?.totalUsd, '2.49');
  assert.equal(after.cost?.items.find((x) => x.key === 'input')?.quantity, '700');
  assert.deepEqual(after.cost?.items.slice(1, 3), before.cost?.items.slice(1, 3));
  assert.equal(
    analytics
      .requests({}, 50, 0)
      .requests.find((x) => x.correlationId === 'zero-write')
      ?.cost?.items.find((x) => x.key === 'cache_write')?.costUsd,
    '0',
  );
  assert.equal(worker.status().requestCount, 2);
  // A later export of an older record must not remove the newly known field.
  reader.put(containers[0], path(), [
    original,
    supplemented,
    zeroWrite,
    { ...original, operationName: 'responses' },
  ]);
  worker.request('scan');
  await worker.settled();
  pricing.recalculate();
  assert.equal(
    analytics.requests({}, 50, 0).requests.find((x) => x.correlationId === 'late-write')?.cost
      ?.totalUsd,
    '2.49',
  );
});
