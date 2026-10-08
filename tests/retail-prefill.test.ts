import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCatalog, decodeRate, groupRates } from '../src/server/pricing/retail.js';
import { prefillOptions } from '../src/server/pricing/prefill.js';
import { retailFamilyMatches } from '../src/shared/price-identity.js';
import { activeRetailRates } from '../src/shared/retail-rates.js';

// Public SKU spellings that caused the original Get Price failures.
function row(skuName: string, retailPrice: string, extra: Record<string, unknown> = {}) {
  return {
    currencyCode: 'USD',
    type: 'Consumption',
    tierMinimumUnits: 0,
    isPrimaryMeterRegion: true,
    productId: 'openai',
    productName: 'Azure OpenAI',
    skuName,
    meterName: `${skuName} 1M Tokens`,
    unitOfMeasure: '1M',
    retailPrice,
    effectiveStartDate: '2026-03-01T00:00:00Z',
    armRegionName: 'eastus2',
    meterId: skuName,
    ...extra,
  };
}
function options(model: string, rows: Record<string, unknown>[]) {
  return prefillOptions(
    groupRates(
      decodeCatalog(rows)
        .map((x) => x.rate)
        .filter((rate) => retailFamilyMatches(model, rate.family, rate.productName)),
    ),
    model,
  );
}

test('GPT-5 abbreviations, caching and product identity keep quotes separate from GPT-5.2', () => {
  const rows = [
    row('GPT 5 Inpt Glbl', '1.25'),
    row('GPT 5 outpt Glbl', '10'),
    row('GPT 5 cchd Inpt Glbl', '0.125'),
    row('GPT 5.2 Inpt Glbl', '1.75'),
    row('GPT 5 Inpt Glbl', '99', { productName: 'MAI Models', productId: 'mai' }),
  ];
  const selected = options('gpt-5', rows);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].prices, {
    input: '1.25',
    output: '10',
    cache_read: '0.125',
    cache_write: '',
  });
  assert.equal(options('gpt-5.2', rows)[0].prices.input, '1.75');
  assert.equal(decodeRate(row('gpt-5-codex-ccchd-inp-glbl', '0.125'))?.component, 'cache_read');
});

test('GPT-4o consolidates punctuation variants and selects model release, not price start date', () => {
  const rows = [
    row('gpt-4o-0806-Inp-glbl', '2.5'),
    row('gpt-4o-0806-Outp-glbl', '10'),
    row('gpt 4o 0806 cached Inp glbl', '1.25'),
  ];
  assert.equal(options('gpt-4o', rows).length, 1);
  assert.equal(options('gpt-4o', rows)[0].prices.cache_read, '1.25');
  rows.push(
    row('gpt 4o 1120 Inp glbl', '2.5', { effectiveStartDate: '2024-12-01T00:00:00Z' }),
    row('gpt 4o 1120 Outp glbl', '10', { effectiveStartDate: '2024-12-01T00:00:00Z' }),
    row('gpt 4o 1120 cached Inp glbl', '1.25', { effectiveStartDate: '2024-12-01T00:00:00Z' }),
    row('gpt 4o 0513 Input global', '5', { effectiveStartDate: '2026-09-01T00:00:00Z' }),
  );
  const quote = options('gpt-4o', rows);
  assert.equal(quote.length, 1);
  assert.equal(quote[0].family, 'gpt 4o 1120');
  assert.equal(quote[0].validFrom, '2024-12-01T00:00:00.000Z');
});

test('GPT-5.4 uses long-specific meters before general meters, preserving shared cache fallback', () => {
  const quote = options('gpt-5.4', [
    row('5.4 inp Gl', '2.5'),
    row('5.4 opt Gl', '15'),
    row('5.4 cd inp Gl', '0.25'),
    row('5.4 longco inp Gl', '5'),
    row('5.4 longco opt Gl', '22.5'),
    row('5.4 longco cd inp Gl', '0.5'),
    row('5.4 Cd Wr Gl', '1'),
    row('5.4 inp Dz', '99'),
    row('5.4 Batch inp Gl', '88'),
  ])[0];
  assert.deepEqual(quote.prices, {
    input: '2.5',
    output: '15',
    cache_read: '0.25',
    cache_write: '1',
  });
  assert.deepEqual(quote.longPrices, {
    input: '5',
    output: '22.5',
    cache_read: '0.5',
    cache_write: '1',
  });
});

test('prefill keeps the two latest actual price periods, explicit expiry, future prices and regional dates', () => {
  const rows = [
    row('fixture Inp Gl', '1', { effectiveStartDate: '2026-01-01T00:00:00Z' }),
    row('fixture Inp Gl', '2', {
      effectiveStartDate: '2026-03-01T00:00:00Z',
      effectiveEndDate: '2026-10-01T00:00:00Z',
    }),
    row('fixture Inp Gl', '3', { effectiveStartDate: '2026-10-01T00:00:00Z' }),
  ];
  const selected = options('fixture', rows);
  assert.equal(selected.length, 2);
  assert.deepEqual(
    selected.map((x) => [x.prices.input, x.validFrom, x.validTo]),
    [
      ['3', '2026-10-01T00:00:00.000Z', null],
      ['2', '2026-03-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ],
  );
  delete (rows[1] as { effectiveEndDate?: string }).effectiveEndDate;
  assert.equal(options('fixture', rows)[1].validTo, null);
  assert.equal(decodeRate(row('fixture Inp Gl', '1', { effectiveEndDate: 'invalid' })), null);
  assert.deepEqual(
    activeRetailRates(
      decodeCatalog([
        row('fixture Inp Gl', '1', { effectiveStartDate: '2026-01-01T00:00:00Z' }),
        row('fixture Inp Gl', '2', { effectiveEndDate: '2026-10-01T00:00:00Z' }),
      ]).map((x) => x.rate),
      '2026-10-01T00:00:00.000Z',
      'all',
    ),
    [],
  );
  assert.equal(
    decodeRate(row('fixture Inp Gl', '1', { effectiveEndDate: '2026-01-01T00:00:00Z' })),
    null,
  );
  const regions = options('fixture', [
    row('fixture Inp Gl', '2'),
    row('fixture Inp Gl', '2', {
      armRegionName: 'westus3',
      effectiveStartDate: '2026-02-01T00:00:00Z',
    }),
  ]);
  assert.equal(regions.length, 2);
  assert.deepEqual(
    regions.map((x) => x.regions),
    [['eastus2'], ['westus3']],
  );
});

test('image meters retain modalities, and OpenAI image quotes never select MAI prices', () => {
  const rows = [
    row('Image 2 txt inp Gl', '5'),
    row('Image 2 txt cd inp Gl', '1.25'),
    row('Image 2 img inp Gl', '8'),
    row('Image 2 img cd inp Gl', '2'),
    row('Image 2 img opt Gl', '30'),
    row('Image 2 Output glbl', '33', { productName: 'MAI Models', productId: 'mai' }),
  ];
  const matched = decodeCatalog(rows)
    .map((x) => x.rate)
    .filter((r) => retailFamilyMatches('gpt-image-2', r.family, r.productName));
  assert.equal(matched.length, 5);
  assert.deepEqual(
    new Set(matched.map((x) => x.component)),
    new Set(['input_text', 'cache_read_text', 'input_image', 'cache_read_image', 'output_image']),
  );
  assert.deepEqual(options('gpt-image-2', rows)[0].prices, {
    input_text: '5',
    input_image: '8',
    cache_read_text: '1.25',
    cache_read_image: '2',
    output_image: '30',
  });
});

test('Foundry product prefixes and abbreviated cache meters match non-OpenAI model IDs', () => {
  for (const [model, productName, skus] of [
    [
      'DeepSeek-V4-Pro',
      'Azure Deepseek Models',
      ['V4 Pro Inp glbl', 'V4 Pro Outp glbl', 'V4 Pro cached glbl'],
    ],
    [
      'Kimi-K2.5',
      'Azure Kimi',
      ['K2.5 Thinking Inp glbl', 'K2.5 Thinking Outp glbl', 'K2.5 cached glbl'],
    ],
    ['grok-4.3', 'Azure Grok Models', ['4.3 Inp Glbl', '4.3 Outp Glbl', '4.3 Cached Inp Glbl']],
  ] as const) {
    const selected = options(
      model,
      skus.map((sku) => row(sku, '2', { productName })),
    );
    assert.equal(selected.length, 1, model);
    assert.equal(selected[0].prices.cache_read, '2', model);
    assert.equal(selected[0].prices.output, '2', model);
  }
});
