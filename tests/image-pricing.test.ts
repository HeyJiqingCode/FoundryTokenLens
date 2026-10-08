import assert from 'node:assert/strict';
import { test } from 'node:test';
import { priceFields, priceTemplate } from '../src/shared/price-form.js';
import { calculateCost } from '../src/server/pricing/engine.js';
import { joinRequest, parseRecord } from '../src/server/ingestion/parser.js';
import { priceSchema } from '../src/server/settings/validation.js';
import { manualPriceBands } from '../src/web/features/settings/prices/model-prices.js';
import type { PriceInput, PriceVersion } from '../src/shared/settings.js';
import { testApp, requestHeaders } from './helpers.js';
import { resource, usage } from './fixtures/diagnostics.js';

const model = 'gpt-IMAGE-2';
const draft: PriceInput = {
  model,
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  notes: '',
  contextPricing: null,
  items: priceFields(model).map((key, index) => ({
    key,
    label: key,
    unitQuantity: 1000000,
    unitPriceUsd: ['5', '8', '1.25', '2', '30'][index],
  })),
};

test('image model IDs select five rates which persist in the model, editor and history', async (t) => {
  assert.equal(priceTemplate(model), 'image');
  assert.equal(priceFields(model).length, 5);
  assert.equal(
    priceSchema.safeParse({
      ...draft,
      contextPricing: { threshold: '1000', longItems: draft.items },
    }).success,
    false,
  );
  assert.equal(priceSchema.safeParse({ ...draft, model: 'gpt-5.6-sol' }).success, false);
  const { app, cookie } = await testApp(t),
    headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/pricing/models',
    headers,
    payload: { displayName: 'Image Fixture', price: draft },
  });
  assert.equal(created.statusCode, 201, created.body);
  const price = created.json().price as PriceVersion;
  assert.deepEqual(price.items, draft.items);
  assert.deepEqual(manualPriceBands(price)[0].values, {
    input_text: ['5'],
    input_image: ['8'],
    cache_read_text: ['1.25'],
    cache_read_image: ['2'],
    output_image: ['30'],
  });
  const edited = await app.inject({
    method: 'PUT',
    url: '/api/pricing/models',
    headers,
    payload: {
      originalModel: model,
      priceId: price.id,
      displayName: 'Image Fixture',
      price: { ...draft, items: draft.items.map((item) => ({ ...item, unitPriceUsd: '0' })) },
    },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().price.items.length, 5);
});

test('image billing uses only explicit per-modality log quantities, never aggregate input/output', () => {
  const price: PriceVersion = {
    ...draft,
    id: 'image-fixture',
    source: 'manual',
    currency: 'USD',
    revision: 1,
    createdAt: draft.validFrom!,
    updatedAt: draft.validFrom!,
  };
  const record = (extra: Record<string, unknown> = {}) =>
    parseRecord(
      JSON.stringify(
        usage('image-usage', {
          modelName: model,
          promptTokens: 1000,
          generatedTokens: 500,
          cachedTokens: 200,
          ...extra,
        }),
      ),
      'usage',
      resource,
    )[0];
  const missing = record();
  const before = calculateCost(joinRequest(missing), [price]);
  assert.equal(before.totalUsd, null);
  assert.deepEqual(
    before.items.map((item) => item.quantity),
    [null, null, '0', '0', null],
  );
  const logged = record({
    inputTextTokens: 100,
    inputImageTokens: [200],
    cachedTextTokens: 30,
    cachedImageTokens: 40,
    outputImageTokens: 50,
  });
  const complete = calculateCost(joinRequest(logged), [price]);
  assert.equal(complete.totalUsd, '0.0032475');
  assert.deepEqual(
    complete.items.map((item) => item.quantity),
    ['70', '160', '30', '40', '50'],
  );
  const partial = calculateCost(joinRequest(record({ inputTextTokens: 0 })), [price]);
  assert.equal(partial.items[0].costUsd, '0');
  assert.equal(partial.items[1].costUsd, null);
  assert.equal(calculateCost(joinRequest(undefined, logged), [price]).status, 'missing_usage');
});
