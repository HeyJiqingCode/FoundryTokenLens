import { test, expect, type Locator } from '@playwright/test';
import { accumulator } from '../../src/server/analytics/aggregate';
import {
  BINNED_MEASURES,
  type AnalyticsResponse,
  type BinnedMeasure,
} from '../../src/shared/analytics';
import type { RequestFact } from '../../src/shared/ingestion';
import { fact, mockApi } from './fixtures';

// Two models served by two resources, over three daily buckets.
const MODELS = ['model-alpha', 'model-beta'];
const RESOURCES = ['/accounts/resource-one', '/accounts/resource-two'];
const DAYS = ['2026-09-26T00:00:00Z', '2026-09-27T00:00:00Z', '2026-09-28T00:00:00Z'];
const calls: RequestFact[] = Array.from({ length: 24 }, (_, i) => ({
  ...fact,
  correlationId: `call-${i}`,
  model: MODELS[i % 2],
  resourceId: RESOURCES[Math.floor(i / 2) % 2],
  time: DAYS[i % 3],
  inputTokens: String(1000 * (i + 1)),
  outputTokens: String(150 + i * 40),
  durationMs: 1200 + i * 900,
  timeToFirstTokenMs: 300 + i * 60,
  timeToLastTokenMs: 1000 + i * 850,
  statusCode: i % 11 === 10 ? 429 : 200,
}));
// Each model's counts within each resource for every binned measure, never 0; the models' and the
// resources' counts, and the whole distribution, are their sums.
const counts = (seed: number, length: number) =>
  Array.from({ length }, (_, i) => 1 + (((i + 1) * (seed + 3)) % 7));
const lengths: Record<BinnedMeasure, number> = {
  duration: 8,
  ttft: 8,
  ttlt: 8,
  speed: 8,
  input: 8,
  output: 8,
  context: 3,
  cost: 8,
};
const pairBins = RESOURCES.flatMap((resource, r) =>
  MODELS.map((name, m) => ({
    resource,
    name,
    counts: Object.fromEntries(
      BINNED_MEASURES.map((measure) => [
        measure,
        counts(r * 2 + m + measure.length, lengths[measure]),
      ]),
    ) as Record<BinnedMeasure, number[]>,
  })),
);
const summed = (name: string, of: (pair: (typeof pairBins)[number]) => boolean) => ({
  name,
  counts: Object.fromEntries(
    BINNED_MEASURES.map((measure) => [
      measure,
      Array.from({ length: lengths[measure] }, (_, i) =>
        pairBins.filter(of).reduce((sum, pair) => sum + pair.counts[measure][i], 0),
      ),
    ]),
  ) as Record<BinnedMeasure, number[]>,
});
const byModel = MODELS.map((name) => summed(name, (pair) => pair.name === name));
const byResource = RESOURCES.map((name) => summed(name, (pair) => pair.resource === name));

function summary(rows: RequestFact[]) {
  const a = accumulator();
  rows.forEach((row) => a.add(row));
  return a.result();
}
function groupedReport(): AnalyticsResponse {
  const points = (rows: RequestFact[]) =>
    DAYS.map((day, i) => {
      const r = summary(rows.filter((c) => c.time === day));
      return {
        i,
        requests: r.requests,
        errors: r.errors,
        costUsd: null,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedTokens: r.cachedTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        itemCostUsd: r.itemCostUsd ?? {},
        cacheRatio: r.cacheRatio,
        p95DurationMs: r.p95DurationMs,
        p95FirstTokenMs: r.p95FirstTokenMs,
        p95LastTokenMs: r.p95LastTokenMs ?? null,
      };
    });
  const stack = (key: 'model' | 'resourceId', names: string[]) =>
    names.map((name) => ({ name, points: points(calls.filter((c) => c[key] === name)) }));
  const inResource = (resource: string, model: string) =>
    calls.filter((c) => c.resourceId === resource && c.model === model);
  const binNames = (length: number) =>
    Array.from({ length }, (_, i) => (length === 3 ? ['short', 'long', 'other'][i] : `bin ${i}`));
  return {
    generatedAt: DAYS[2],
    interval: '1d',
    timezone: 'Asia/Shanghai',
    summary: summary(calls),
    timeline: DAYS.map((date) => ({ date, ...summary(calls.filter((c) => c.time === date)) })),
    models: MODELS.map((name) => ({ name, ...summary(calls.filter((c) => c.model === name)) })),
    resources: RESOURCES.map((name) => ({
      name,
      ...summary(calls.filter((c) => c.resourceId === name)),
    })),
    stacks: {
      model: stack('model', MODELS),
      resource: stack('resourceId', RESOURCES),
      pairs: RESOURCES.flatMap((resource) =>
        MODELS.map((name) => ({ resource, name, points: points(inResource(resource, name)) })),
      ),
    },
    measureBins: { model: byModel, resource: byResource, pairs: pairBins },
    resourceModels: RESOURCES.flatMap((resource) =>
      MODELS.map((name) => ({ resource, name, ...summary(inResource(resource, name)) })),
    ),
    distributions: Object.fromEntries(
      BINNED_MEASURES.map((measure) => [
        measure,
        binNames(lengths[measure]).map((name, i) => ({
          name,
          count: byModel.reduce((sum, group) => sum + group.counts[measure][i], 0),
          costUsd: null,
        })),
      ]),
    ),
    // More status codes than the card shows, so its list has to scroll.
    statuses: ['200', '429', '400', '401', '403', '404', '408', '409', '500', '502', '503'].map(
      (name, i) => ({ name, count: 100 - i * 9 }),
    ),
    slowest: { duration: calls, ttft: calls, ttlt: calls, speed: calls },
    topCosts: calls.slice(0, 20),
    lowestCache: {
      nonZero: calls,
      zero: calls.slice(0, 3).map((call) => ({ ...call, cachedTokens: '0' })),
    },
    // Ten days of a thirty-day month spent, the rest forecast, against last month's total.
    monthForecast: {
      days: Array.from({ length: 30 }, (_, i) =>
        new Date(Date.UTC(2026, 8, i + 1) - 8 * 3600000).toISOString(),
      ),
      actual: Array.from({ length: 30 }, (_, i) => (i < 10 ? (i + 1) * 2 : null)),
      forecast: Array.from({ length: 30 }, (_, i) => (i < 9 ? null : 20 + (i - 9) * 2)),
      previous: 50,
    },
    scatter: calls.map((c) => ({
      id: c.correlationId,
      model: c.model!,
      input: Number(c.inputTokens),
      ttft: c.timeToFirstTokenMs!,
    })),
    heatmap: [
      { day: 2, hour: 21, requests: 12 },
      { day: 0, hour: 9, requests: 3 },
    ],
    ips: [],
    facets: { models: MODELS, resources: RESOURCES, ips: [] },
  };
}

async function open(page: import('@playwright/test').Page, path: string, query = '') {
  const state = await mockApi(page);
  state.report = groupedReport();
  await page.goto(`${path}?language=en-US${query}`);
  await expect(page.locator('.kpi-row').first()).toBeVisible();
}
const card = (page: import('@playwright/test').Page, title: string) =>
  page.locator('.card', { has: page.getByRole('heading', { name: title, exact: true }) });
const height = (locator: Locator) =>
  locator.evaluate((element) => (element as HTMLElement).offsetHeight);

test('split cards default to models, keep their height and switch width, and hover like the time charts', async ({
  page,
}) => {
  await open(page, '/analysis/performance');
  const distribution = card(page, 'Duration distribution');
  const split = distribution.getByRole('group', { name: 'Split' });
  await expect(split.getByRole('button', { name: 'Model' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(distribution.locator('.chart-legend')).toContainText('model-alpha');
  const [cardHeight, switchWidth] = [
    await height(distribution),
    await split.evaluate((element) => element.getBoundingClientRect().width),
  ];
  await split.getByRole('button', { name: 'Resource' }).click();
  await expect(distribution.locator('.chart-legend')).toContainText('resource-one');
  expect(await height(distribution)).toBe(cardHeight);
  expect(await split.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    switchWidth,
  );
  // A bin's tooltip names it in full and lists each resource with its calls, then the total.
  await distribution.locator('.histogram-column').nth(1).hover();
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('bin 1');
  await expect(tooltip).toContainText('resource-one');
  await expect(tooltip).toContainText('Total');
  await expect(tooltip).toContainText('calls');
  // Each resource lists its models beneath it.
  await expect(tooltip.locator('.chart-tooltip-row.part')).toHaveCount(4);
  await expect(tooltip.locator('.chart-tooltip-row.part').first()).toContainText('model-');
});

test('lists sharing a row scroll inside a card of the row height, without a scrollbar', async ({
  page,
}) => {
  await open(page, '/analysis/performance');
  const status = card(page, 'Response status');
  const errors = card(page, 'Errors');
  expect(await height(status)).toBe(await height(errors));
  const body = status.locator('.scroll-body');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(status.locator('.scroll-rail')).toHaveCount(0);
  // The slowest calls show all of them in a window, from the top again after each switch.
  const slowest = card(page, 'Longest calls');
  await expect(slowest.locator('.call-list li')).toHaveCount(calls.length);
  await slowest.locator('.scroll-body').evaluate((element) => (element.scrollTop = 200));
  await slowest.getByRole('button', { name: 'TTFT' }).click();
  await expect(card(page, 'Slowest TTFT calls').locator('.scroll-body')).toHaveJSProperty(
    'scrollTop',
    0,
  );
});

test('value axes carry their unit, all but the 0, and start at the legend’s left edge', async ({
  page,
}) => {
  await open(page, '/analysis/performance');
  const errors = card(page, 'Errors');
  const ticks = errors.locator('.chart svg text[x="0"]');
  // Every tick carries its unit except the 0 where the axes meet.
  await expect(ticks.first()).toHaveText('0');
  // Counts step in whole calls: never 0.25 of one.
  await expect(ticks.nth(1)).toHaveText(/^\d[\d,]* calls?$/);
  const [legendLeft, tickLeft] = await Promise.all([
    errors.locator('.chart-legend').evaluate((element) => element.getBoundingClientRect().left),
    ticks.first().evaluate((element) => element.getBoundingClientRect().left),
  ]);
  expect(Math.abs(tickLeft - legendLeft)).toBeLessThan(1);
});

test('context bands are bars as long as their share, stacked by model, with their calls', async ({
  page,
}) => {
  await open(page, '/analysis/tokens');
  const context = card(page, 'Context distribution');
  const rows = context.locator('.band-bar');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('Short context');
  await expect(rows.first()).toContainText('calls');
  // Each band's bar is split into one segment per model.
  await expect(rows.first().locator('.band-bar-fill i')).toHaveCount(MODELS.length);
  await rows.first().hover();
  await expect(page.locator('.chart-tooltip')).toContainText('Short context');
  await expect(page.locator('.chart-tooltip')).toContainText('model-alpha');
});

test('weekday × hour cells show their hour and calls in a tooltip like the time charts', async ({
  page,
}) => {
  await open(page, '/analysis/distribution');
  const heatmap = card(page, 'Weekday × hour');
  await heatmap.locator('.heatmap-row').nth(2).locator('i').nth(21).hover();
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('21:00 – 22:00');
  await expect(tooltip).toContainText('12 calls');
  await expect(heatmap.locator('.heatmap-row i.hovered')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
});

test('token types are measured in tokens, not calls', async ({ page }) => {
  await open(page, '/analysis/tokens');
  const types = card(page, 'Token distribution');
  const rows = types.locator('.band-bar');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('Output');
  await rows.first().hover();
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('Input');
  await expect(tooltip).not.toContainText('calls');
});

test('the lowest cache hit rates sit beside the cache hit rate, non-zero rates first, zero ones a switch away', async ({
  page,
}) => {
  await open(page, '/analysis/tokens');
  const list = card(page, 'Lowest cache hit rate calls');
  const cardHeight = await height(list);
  expect(cardHeight).toBe(await height(card(page, 'Cache hit rate')));
  const groups = list.getByRole('group', { name: 'Lowest cache hit rate calls' });
  await expect(groups.getByRole('button', { name: 'Non-zero' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(list.locator('.call-list li')).toHaveCount(calls.length);
  await expect(list.locator('.call-list li').first()).toContainText('Cache reads');
  const body = list.locator('.scroll-body');
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(list.locator('.scroll-rail')).toHaveCount(0);
  // The zero rates open from the top, in a card of the same height and a switch of the same width.
  const switchWidth = await groups.evaluate((element) => element.getBoundingClientRect().width);
  await body.evaluate((element) => (element.scrollTop = 200));
  await groups.getByRole('button', { name: '0%' }).click();
  await expect(list.locator('.call-list li')).toHaveCount(3);
  await expect(list.locator('.scroll-body')).toHaveJSProperty('scrollTop', 0);
  expect(await height(list)).toBe(cardHeight);
  expect(await groups.evaluate((element) => element.getBoundingClientRect().width)).toBe(
    switchWidth,
  );
});

test('the cost view pairs the composition with the costliest calls and the cost per call with the month forecast', async ({
  page,
}) => {
  await open(page, '/analysis/cost');
  const [composition, costliest, perCall, forecast] = [
    'Cost composition',
    'Most expensive calls',
    'Cost per call distribution',
    "This month's cost forecast",
  ].map((title) => card(page, title));
  expect(await height(composition)).toBe(await height(costliest));
  expect(await height(perCall)).toBe(await height(forecast));
  expect(await height(costliest)).toBeGreaterThan(await height(forecast));
  await expect(costliest.locator('.call-list li')).toHaveCount(20);
  await expect(forecast.locator('.chart-legend')).toContainText('Last month total');
  // A day ahead shows its forecast, not a spent amount, with last month for reference.
  const chart = forecast.locator('.chart svg');
  const box = (await chart.boundingBox())!;
  await chart.hover({ position: { x: box.width - 12, y: box.height / 2 } });
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('Forecast');
  await expect(tooltip).not.toContainText('Accumulated cost');
  await expect(tooltip).toContainText('Last month total');
  // The overall cost can be split by billing type, and the breakdown shows the cache savings.
  const overall = card(page, 'Overall cost');
  await overall.getByRole('group', { name: 'Split' }).getByRole('button', { name: 'Type' }).click();
  await expect(overall.locator('.chart-legend')).toContainText('Cache read');
  await expect(page.getByRole('columnheader', { name: 'Cache savings' })).toBeVisible();
});

test('charts split by type list each type by model on hover', async ({ page }) => {
  await open(page, '/analysis/tokens');
  const tokens = card(page, 'Tokens');
  await tokens.getByRole('group', { name: 'Split' }).getByRole('button', { name: 'Type' }).click();
  const chart = tokens.locator('.chart svg');
  const box = (await chart.boundingBox())!;
  await chart.hover({ position: { x: box.width - 20, y: box.height / 2 } });
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('Output');
  // Every type with tokens in the bucket names the two models under it.
  const parts = tooltip.locator('.chart-tooltip-row.part');
  await expect(parts.filter({ hasText: 'model-alpha' }).first()).toBeVisible();
  await expect(parts.filter({ hasText: 'model-beta' }).first()).toBeVisible();
});

test('a long tooltip is drawn above its card and kept inside the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await open(page, '/analysis/tokens');
  const types = card(page, 'Token distribution');
  await types
    .getByRole('group', { name: 'Split' })
    .getByRole('button', { name: 'Resource' })
    .click();
  await types.locator('.band-bar').first().hover();
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip.locator('.chart-tooltip-row.part').first()).toBeVisible();
  // Outside the card's scrolling list, with every row inside the window.
  expect(await types.locator('.chart-tooltip').count()).toBe(0);
  const box = (await tooltip.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(560);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);
});

test('the overview total lists each resource with its models on hover, then the total', async ({
  page,
}) => {
  await open(page, '/overview');
  // The mocked calls carry no cost, so the chart shows their count.
  const chart = page.locator('.card', { has: page.getByRole('group', { name: 'Metric' }) });
  await chart.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Calls' }).click();
  const svg = chart.locator('.chart svg');
  const box = (await svg.boundingBox())!;
  await svg.hover({ position: { x: box.width - 20, y: box.height / 2 } });
  const tooltip = page.locator('.chart-tooltip');
  await expect(tooltip).toContainText('resource-one');
  await expect(tooltip).toContainText('resource-two');
  await expect(
    tooltip.locator('.chart-tooltip-row.part').filter({ hasText: 'model-alpha' }).first(),
  ).toBeVisible();
  await expect(tooltip.locator('.chart-tooltip-row.total')).toBeVisible();
});

test('dragging across a time chart selects its buckets as the time range, keeping the granularity', async ({
  page,
}) => {
  await open(page, '/analysis/tokens', '&interval=1d');
  const chart = card(page, 'Tokens').locator('.chart svg');
  await expect(chart).toHaveClass(/brushable/);
  const box = (await chart.boundingBox())!;
  const search = () => new URL(page.url()).searchParams;
  // A click is not a drag: the range stays as it was once the click has been handled.
  await chart.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(search().get('from')).toBeNull();
  // From the last day back into the middle one: both whole days, without a tooltip meanwhile.
  await page.mouse.move(box.x + box.width - 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await expect(chart.locator('.chart-brush')).toHaveCount(1);
  await expect(page.locator('.chart-tooltip')).toHaveCount(0);
  await page.mouse.up();
  await expect.poll(() => search().get('from')).not.toBeNull();
  expect(Date.parse(search().get('from')!)).toBe(Date.parse(DAYS[1]));
  expect(Date.parse(search().get('to')!)).toBe(Date.parse('2026-09-29T00:00:00Z'));
  expect(search().get('range')).toBeNull();
  expect(search().get('interval')).toBe('1d');
  await expect(chart.locator('.chart-brush')).toHaveCount(0);
});
