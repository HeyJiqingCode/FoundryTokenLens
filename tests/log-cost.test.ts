import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinRequest, parseRecord } from '../src/server/ingestion/parser.js';
import { calculateCost } from '../src/server/pricing/engine.js';
import type { PriceVersion } from '../src/shared/settings.js';
import { resource, usage } from './fixtures/diagnostics.js';

const price: PriceVersion = {
  id: 'log-spec-price',
  source: 'manual',
  currency: 'USD',
  revision: 1,
  model: 'gpt-5.6-sol',
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  notes: '',
  items: [
    { key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '4' },
    { key: 'cache_read', label: 'Cache read', unitQuantity: 1000000, unitPriceUsd: '0.4' },
    { key: 'output', label: 'Output', unitQuantity: 1000000, unitPriceUsd: '20' },
    { key: 'cache_write', label: 'Cache write', unitQuantity: 1000000, unitPriceUsd: '5' },
  ],
};

function logFact(extra: Record<string, unknown> = {}) {
  return joinRequest(
    parseRecord(
      JSON.stringify(
        usage('log-spec-request', {
          modelName: price.model,
          promptTokens: [58990],
          cachedTokens: [58255],
          generatedTokens: [332],
          ...extra,
        }),
      ),
      'usage',
      resource,
    )[0],
  );
}

test('each prompt token is billed once: ordinary input excludes cache reads and cache writes', () => {
  const fact = logFact();
  const cost = calculateCost(fact, [price]);
  // 58,990 prompt tokens − 58,255 cache reads = 735 ordinary input tokens; no logged writes = 0.
  assert.deepEqual(
    cost.items.map(({ key, quantity, costUsd }) => [key, quantity, costUsd]),
    [
      ['input', '735', '0.00294'],
      ['cache_read', '58255', '0.023302'],
      ['output', '332', '0.00664'],
      ['cache_write', '0', '0'],
    ],
  );
  assert.equal(cost.totalUsd, '0.032882');
  assert.equal(cost.knownUsd, '0.032882');
  assert.equal(cost.status, 'complete');
  assert.equal(fact.inputTokens, '58990');

  for (const [writes, input, expected] of [
    [0, '735', '0.032882'],
    [500, '235', '0.033382'],
  ] as const) {
    const withWrites = calculateCost(logFact({ cacheWriteTokens: [writes] }), [price]);
    assert.equal(withWrites.items[0].quantity, input);
    assert.equal(withWrites.items[3].quantity, String(writes));
    assert.equal(withWrites.totalUsd, expected);
    assert.equal(withWrites.status, 'complete');
  }

  const noWriteRate = calculateCost(fact, [{ ...price, items: price.items.slice(0, 3) }]);
  assert.equal(noWriteRate.totalUsd, '0.032882');
  const missingInput = calculateCost(logFact({ promptTokens: null }), [price]);
  assert.equal(missingInput.items[0].costUsd, null);
  assert.equal(missingInput.knownUsd, '0.029942');
  const inconsistentCache = calculateCost(logFact({ cachedTokens: 100000 }), [price]);
  assert.equal(inconsistentCache.items[0].quantity, '0');
  assert.equal(inconsistentCache.knownUsd, '0.04664');
});

test('a prompt split into cache reads and cache writes has no ordinary input left to bill', () => {
  const sol: PriceVersion = {
    ...price,
    model: 'gpt-6-sol',
    items: [
      { key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '2' },
      { key: 'cache_read', label: 'Cache read', unitQuantity: 1000000, unitPriceUsd: '0.2' },
      { key: 'output', label: 'Output', unitQuantity: 1000000, unitPriceUsd: '10' },
      { key: 'cache_write', label: 'Cache write', unitQuantity: 1000000, unitPriceUsd: '2.5' },
    ],
  };
  const cost = calculateCost(
    logFact({
      modelName: 'gpt-6-sol',
      promptTokens: [10000],
      cachedTokens: [9000],
      cacheWriteTokens: [1000],
      generatedTokens: [500],
    }),
    [sol],
  );
  assert.deepEqual(
    cost.items.map(({ key, quantity, costUsd }) => [key, quantity, costUsd]),
    [
      ['input', '0', '0'],
      ['cache_read', '9000', '0.0018'],
      ['output', '500', '0.005'],
      ['cache_write', '1000', '0.0025'],
    ],
  );
  assert.equal(cost.totalUsd, '0.0093');
});

test('context tier selects one rate row using all prompt tokens, then prices the partitioned quantities', () => {
  const tiered = {
    ...price,
    contextPricing: {
      threshold: '58990',
      longItems: price.items.map((item, index) => ({
        ...item,
        unitPriceUsd: ['8', '0.8', '30', '10'][index],
      })),
    },
  };
  const atBoundary = calculateCost(logFact(), [tiered]);
  assert.equal(atBoundary.totalUsd, '0.032882');
  const above = calculateCost(logFact({ promptTokens: 60000 }), [tiered]);
  assert.deepEqual(
    above.items.map((item) => item.unitPriceUsd),
    ['8', '0.8', '30', '10'],
  );
  assert.deepEqual(
    above.items.map((item) => item.costUsd),
    ['0.01396', '0.046604', '0.00996', '0'],
  );
  assert.equal(above.totalUsd, '0.070524');
  const withWrites = calculateCost(logFact({ promptTokens: 60000, cacheWriteTokens: 1000 }), [
    tiered,
  ]);
  assert.equal(withWrites.totalUsd, '0.072524');
  const cacheDoesNotSelectTier = calculateCost(logFact({ cachedTokens: 100000 }), [tiered]);
  assert.deepEqual(
    cacheDoesNotSelectTier.items.map((item) => item.unitPriceUsd),
    ['4', '0.4', '20', '5'],
  );
});

test('request time selects a single price version before context-tier calculation', () => {
  const boundary = '2026-09-20T02:00:00.000Z';
  const old = { ...price, validTo: boundary };
  const next = {
    ...price,
    id: 'next-price',
    validFrom: boundary,
    items: price.items.map((item) => ({ ...item, unitPriceUsd: '1' })),
  };
  const fact = logFact();
  assert.equal(
    calculateCost({ ...fact, time: '2026-09-20T01:59:59.999Z' }, [old, next]).totalUsd,
    '0.032882',
  );
  assert.equal(calculateCost({ ...fact, time: boundary }, [old, next]).totalUsd, '0.059322');
  assert.equal(
    calculateCost({ ...fact, time: '2026-08-31T23:59:59.999Z' }, [old, next]).knownUsd,
    null,
  );
});
