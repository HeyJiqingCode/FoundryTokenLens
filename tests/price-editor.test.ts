import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPrices, formPrices, pricePerMillion } from '../src/shared/price-form.js';
import { prefillOptions } from '../src/server/pricing/prefill.js';
import { decodeCatalog, groupRates } from '../src/server/pricing/retail.js';
import { priceSchema } from '../src/server/settings/validation.js';
import { requestHeaders, testApp } from './helpers.js';
import type { PriceInput, PriceVersion } from '../src/shared/settings.js';
import { calculateCost } from '../src/server/pricing/engine.js';
import { parseRecord } from '../src/server/ingestion/parser.js';
import {
  manualPriceBands,
  modelSummary,
} from '../src/web/features/settings/prices/model-prices.js';
import { usage, resource } from './fixtures/diagnostics.js';

function raw(sku: string, value: string, region = 'eastus2') {
  return {
    currencyCode: 'USD',
    type: 'Consumption',
    tierMinimumUnits: 0,
    isPrimaryMeterRegion: true,
    productId: 'synthetic',
    productName: 'Synthetic GPT',
    skuName: sku,
    meterName: `${sku} 1K Tokens`,
    unitOfMeasure: '1K',
    retailPrice: value,
    effectiveStartDate: '2026-09-01T00:00:00Z',
    armRegionName: region,
    meterId: `${region}-${sku}`,
  };
}
const item = { key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '2' };
const draft: PriceInput = {
  model: 'synthetic-model',
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  notes: '',
  items: [item],
  contextPricing: { threshold: '1000', longItems: [{ ...item, unitPriceUsd: '4' }] },
};

test('editor converts Retail units exactly and keeps blank distinct from zero', () => {
  assert.equal(pricePerMillion('0.000000000001', 1000), '0.000000001');
  assert.equal(pricePerMillion('0.0037', 1000), '3.7');
  assert.equal(pricePerMillion('0', 1000), '0');
  assert.deepEqual(formPrices([{ ...item, key: 'cache_read', unitPriceUsd: '0' }]), {
    ...emptyPrices(),
    cache_read: '0',
  });
  assert.throws(() => pricePerMillion('1', 3));
});

test('Retail prefill pairs context bands and collapses identical regional rates without mixing tiers', () => {
  const rows = ['eastus2', 'westus3'].flatMap((region) => [
    raw('5.6 sol ShortCo Inp Std Gl', '0.004', region),
    raw('5.6 sol ShortCo Opt Std Gl', '0.020', region),
    raw('5.6 sol LongCo Inp Std Gl', '0.008', region),
    raw('5.6 sol LongCo Opt Std Gl', '0.030', region),
    raw('5.6 sol LongCo Cd Wr Std Gl', '0.010', region),
    raw('5.6 sol Cd Inp Std Gl', '0', region),
    raw('5.6 sol ShortCo Inp PP Gl', '9', region),
    raw('5.6 sol Inp DZ', '7', region),
  ]);
  const options = prefillOptions(groupRates(decodeCatalog(rows).map((x) => x.rate)));
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].regions.sort(), ['eastus2', 'westus3']);
  assert.deepEqual(options[0].prices, {
    input: '4',
    output: '20',
    cache_read: '0',
    cache_write: '',
  });
  assert.deepEqual(options[0].longPrices, {
    input: '8',
    output: '30',
    cache_read: '0',
    cache_write: '10',
  });
  const ambiguous = groupRates(
    decodeCatalog([
      raw('5.6 sol Inp Gl', '1'),
      { ...raw('5.6 sol Inp Gl', '2'), meterId: 'other' },
    ]).map((x) => x.rate),
  );
  assert.throws(
    () => prefillOptions(ambiguous),
    /pricing.retailReturnedMultipleRatesForTheSameMeter/,
  );
  const unsupported = groupRates(
    decodeCatalog([raw('gpt img 1.5 in img Gl', '8')]).map((x) => x.rate),
  );
  assert.throws(() => prefillOptions(unsupported), /pricing.prefillUnsupported/);
});

test('Retail prefill only returns Global Standard prices', () => {
  const groups = groupRates(
    decodeCatalog([
      raw('5.6 sol Inp Std Gl', '0.004'),
      raw('5.6 sol Inp Std DZ', '0.005'),
      raw('5.6 sol Inp regnl', '0.006'),
      raw('5.6 sol Inp PP Gl', '0.099'),
    ]).map(({ rate }) => rate),
  );
  const options = prefillOptions(groups);
  assert.equal(options.length, 1);
  assert.equal(options[0].family, '5.6 sol');
  assert.equal(options[0].prices.input, '4');
  const aliases = groupRates(
    decodeCatalog([
      raw('fixture Inp DZone', '0.007'),
      raw('fixture Inp DZn', '0.007'),
      raw('fixture Inp rgnl', '0.008'),
    ]).map(({ rate }) => rate),
  );
  assert.deepEqual(prefillOptions(aliases), []);
});

test('manual context threshold is versioned, exact at its boundary, and persists across edits', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: draft,
  });
  assert.equal(created.statusCode, 201);
  const first = created.json().price as PriceVersion;
  assert.deepEqual(first.contextPricing, draft.contextPricing);
  const record = parseRecord(
    JSON.stringify(usage('threshold', { promptTokens: 1000 })),
    'usage',
    resource,
  )[0];
  assert.ok(record.fact);
  const fact = record.fact!;
  const at = calculateCost(fact, [first]);
  assert.equal(at.items[0].unitPriceUsd, '2');
  const above = calculateCost({ ...fact, inputTokens: '1001' }, [first]);
  assert.equal(above.items[0].unitPriceUsd, '4');
  assert.equal(above.totalUsd, '0.003964');
  assert.equal(calculateCost({ ...fact, inputTokens: null }, [first]).totalUsd, null);
  const secondResponse = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: {
      ...draft,
      validFrom: '2026-10-01T00:00:00Z',
      contextPricing: { ...draft.contextPricing, threshold: '2000' },
    },
  });
  assert.equal(secondResponse.statusCode, 201);
  const prices = (await app.inject({ url: '/api/settings/prices', headers })).json()
    .prices as PriceVersion[];
  assert.equal(calculateCost({ ...fact, inputTokens: '1001' }, prices).items[0].unitPriceUsd, '4');
  assert.equal(
    calculateCost({ ...fact, inputTokens: '1001', time: '2026-10-01T00:00:00.000Z' }, prices)
      .items[0].unitPriceUsd,
    '2',
  );
  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/settings/prices/${first.id}`,
    headers,
    payload: {
      items: first.items,
      notes: '',
      contextPricing: { threshold: '500', longItems: [{ ...item, unitPriceUsd: '6' }] },
    },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(calculateCost(fact, [edited.json().price]).items[0].unitPriceUsd, '6');
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/settings/prices/${first.id}`,
    headers,
    payload: { items: first.items, notes: '', contextPricing: null },
  });
  assert.equal(disabled.json().price.contextPricing, null);
  for (const threshold of ['0', '-1', '1.5', '10000000000', ''])
    assert.equal(
      priceSchema.safeParse({ ...draft, contextPricing: { ...draft.contextPricing, threshold } })
        .success,
      false,
    );
  assert.equal(
    priceSchema.safeParse({
      ...draft,
      contextPricing: { threshold: '1000', longItems: [item, item] },
    }).success,
    false,
  );
});

test('compact model pricing separates context bands, respects effective dates, and keeps missing rates distinct from zero', () => {
  const first: PriceVersion = {
    ...draft,
    id: 'first',
    source: 'manual',
    currency: 'USD',
    revision: 1,
    createdAt: draft.validFrom!,
    updatedAt: draft.validFrom!,
    validTo: '2026-10-01T00:00:00.000Z',
    items: [...draft.items, { ...item, key: 'cache_read', unitPriceUsd: '0' }],
  };
  const future = {
    ...first,
    id: 'future',
    validFrom: first.validTo!,
    validTo: null,
    items: [{ ...item, unitPriceUsd: '8' }],
    contextPricing: { threshold: '2000', longItems: [{ ...item, unitPriceUsd: '16' }] },
  };
  const model = { name: draft.model, scopes: [], prices: [future, first] };
  const current = modelSummary(model, '2026-09-22T00:00:00.000Z');
  assert.deepEqual(current.bands, [
    { kind: 'short', values: { input: ['2'], cache_read: ['0'] } },
    { kind: 'long', values: { input: ['4'] } },
  ]);
  assert.equal(current.bands[0].values.cache_write, undefined);
  assert.equal(current.bands[1].values.cache_read, undefined);
  assert.deepEqual(
    modelSummary(model, future.validFrom).bands.map((band) => band.values.input),
    [['8'], ['16']],
  );
  assert.deepEqual(modelSummary(model, '2026-08-31T23:59:59.999Z').bands, []);
  assert.deepEqual(
    manualPriceBands(first).map((band) => [band.kind, band.threshold, band.values.input]),
    [
      ['short', '1000', ['2']],
      ['long', '1000', ['4']],
    ],
  );
  assert.equal(manualPriceBands({ ...first, contextPricing: null }).length, 1);
});
