import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeBoundary } from '../src/shared/time-window.js';
import {
  dateLabel,
  perMillion,
  rateRange,
} from '../src/web/features/settings/prices/model-prices.js';
import { setLocale } from '../src/web/i18n/locale.js';
test('date-only ranges and price dates are independent of browser zone, including DST', () => {
  const prior = process.env.TZ;
  setLocale('zh-CN');
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai']) {
      process.env.TZ = zone;
      assert.equal(rangeBoundary('2026-09-01', 'Asia/Shanghai'), '2026-08-31T16:00:00.000Z');
      assert.equal(rangeBoundary('2026-09-01', 'Asia/Shanghai', true), '2026-09-01T16:00:00.000Z');
      assert.equal(dateLabel('2026-09-01T00:00:00Z'), '2026/09/01');
    }
    assert.equal(rangeBoundary('2026-11-01', 'America/New_York', true), '2026-11-02T05:00:00.000Z');
    assert.equal(
      rangeBoundary('2026-09-01T00:00:00Z', 'Asia/Shanghai', true),
      '2026-09-01T00:00:00.000Z',
    );
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});
test('price display uses exact decimal units without floating point artifacts', () => {
  assert.equal(perMillion({ unitPriceUsd: '0.00391', unitQuantity: 1000 }), '3.91');
  assert.equal(rateRange(['3.91']), '3.91');
  assert.equal(rateRange(['10.000000000001', '0.000000000001']), '0.000000000001–10.000000000001');
});
