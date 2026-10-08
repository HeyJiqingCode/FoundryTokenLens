import { test, expect } from '@playwright/test';
import { mockApi } from './fixtures';
test('request view uses facets not reports, preserves an open detail and pauses in background', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.clock.install();
  await page.goto('/requests?range=7d&language=en-US');
  await expect(page.locator('.request-open')).toBeVisible();
  expect(state.requests.filter((r) => r.path === 'analytics')).toHaveLength(0);
  expect(state.requests.some((r) => r.path === 'analytics/facets')).toBe(true);
  await page.locator('.request-open').click();
  const d = page.locator('.request-drawer');
  await expect(d).toBeVisible();
  const count = state.requests.filter((r) => r.path === 'requests').length;
  await page.clock.fastForward(120000);
  await expect(d).toBeVisible();
  expect(state.requests.filter((r) => r.path === 'requests')).toHaveLength(count);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(0);
  const n = state.requests.length;
  await page.clock.fastForward(120000);
  expect(state.requests).toHaveLength(n);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => state.requests.length).toBeGreaterThan(n);
  await expect(d).toBeVisible();
});
test('an import revision refreshes reports while a rendering error has a recoverable page boundary', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.clock.install();
  await page.goto('/overview?range=7d&language=en-US');
  await expect(page.locator('.overview-kpis')).toBeVisible();
  const n = state.requests.filter((r) => r.path === 'analytics').length;
  state.revision = '2';
  await page.clock.fastForward(30001);
  await expect
    .poll(() => state.requests.filter((r) => r.path === 'analytics').length)
    .toBeGreaterThan(n);
  state.brokenReport = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('This page could not be displayed', { exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  state.brokenReport = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('.overview-kpis')).toBeVisible();
});
test('selected timezone and exact price labels are independent of the browser timezone', async ({
  page,
}) => {
  await mockApi(page);
  await page.goto('/overview?language=en-US');
  const result = await page.evaluate(async () => {
    // Modules are loaded from the Vite dev server inside the page.
    const load = (path: string) => import(/* @vite-ignore */ path);
    const prices = await load('/features/settings/prices/model-prices.ts');
    const filters = await load('/features/analytics/useAnalytics.ts');
    return {
      date: prices.dateLabel('2026-09-01T00:00:00Z'),
      price: prices.rateRange([prices.perMillion({ unitPriceUsd: '0.00391', unitQuantity: 1000 })]),
      range: filters.filterQuery({
        ...filters.emptyFilters,
        from: '2026-09-01',
        to: '2026-09-01',
        timezone: 'Asia/Shanghai',
      }),
    };
  });
  expect(result.price).toBe('3.91');
  expect(result.range).toContain('2026-08-31T16%3A00%3A00.000Z');
  expect(result.date).toContain('09/01/2026');
});

test('manual refresh remains available on a later page with an absolute range', async ({
  page,
}) => {
  const state = await mockApi(page);
  await page.clock.install();
  await page.goto(
    '/requests?from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-02T00%3A00%3A00.000Z&page=2&language=en-US',
  );
  await expect(page.locator('.request-open')).toBeVisible();
  const n = state.requests.filter((r) => r.path === 'requests').length;
  await page.clock.fastForward(60001);
  expect(state.requests.filter((r) => r.path === 'requests')).toHaveLength(n);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect
    .poll(() => state.requests.filter((r) => r.path === 'requests').length)
    .toBeGreaterThan(n);
});
