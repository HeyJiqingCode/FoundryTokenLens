import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tokenTypeSeries } from '../src/web/features/analytics/series.js';
import type { AnalyticsResponse, UsageSummary } from '../src/shared/analytics.js';

const bucket = (
  date: string,
  tokens: Pick<UsageSummary, 'inputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'outputTokens'>,
) =>
  ({
    date,
    requests: 1,
    knownStatus: 1,
    errors: 0,
    costUsd: null,
    cacheRatio: null,
    averageDurationMs: null,
    p95DurationMs: null,
    p95FirstTokenMs: null,
    ...tokens,
  }) as AnalyticsResponse['timeline'][number];

test('token types partition prompt tokens like billing: ordinary input excludes cache reads and writes', () => {
  const data = {
    timeline: [
      bucket('2026-09-28T00:00:00Z', {
        inputTokens: '10000',
        cachedTokens: '9000',
        cacheWriteTokens: '600',
        outputTokens: '500',
      }),
      // Logs without cache writes: the whole remainder is ordinary input.
      bucket('2026-09-28T01:00:00Z', {
        inputTokens: '1000',
        cachedTokens: '200',
        cacheWriteTokens: null,
        outputTokens: '100',
      }),
      bucket('2026-09-28T02:00:00Z', {
        inputTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
      }),
    ],
  } as AnalyticsResponse;
  const series = Object.fromEntries(tokenTypeSeries(data).map((s) => [s.key, s.values]));
  assert.deepEqual(Object.keys(series), ['ordinary', 'cacheWrite', 'cacheRead', 'output']);
  assert.deepEqual(series.ordinary, [400, 800, 0]);
  assert.deepEqual(series.cacheWrite, [600, 0, 0]);
  assert.deepEqual(series.cacheRead, [9000, 200, 0]);
  assert.deepEqual(series.output, [500, 100, 0]);
  // The stack still adds up to prompt tokens plus output tokens.
  assert.deepEqual(
    data.timeline.map((_, i) =>
      Object.values(series as Record<string, number[]>).reduce((sum, values) => sum + values[i], 0),
    ),
    [10500, 1100, 0],
  );
});
