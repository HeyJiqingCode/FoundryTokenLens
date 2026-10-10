import type { CostContext } from './pricing.js';

export const INTERVALS = ['auto', '1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];
/** The distribution report lists this many of the busiest source IPs. */
export const TOP_SOURCE_IPS = 100;
export const TIME_RANGES = [
  '30m',
  '1h',
  '4h',
  '12h',
  '1d',
  '48h',
  '3d',
  '7d',
  '14d',
  '30d',
  'all',
] as const;
export type TimeRange = (typeof TIME_RANGES)[number];
export interface AnalyticsFilters {
  requestId?: string;
  interval?: Interval;
  timezone?: string;
  /** 'ok' / 'error' (known status below / at least 400), a class such as '4xx', a code, 'unknown' or 'conflict'. */
  status?: string;
  /** Also match calls that are not model inference; only the request detail lookup needs it. */
  includeNonModel?: boolean;
  from?: string;
  to?: string;
  model?: string;
  resourceId?: string;
  ip?: string;
  /** The context row the billing engine priced the call with. */
  context?: CostContext;
  /** Server-side view restriction: model calls are limited to these priced models. */
  pricedModels?: string[];
}
export interface UsageSummary {
  requests: number;
  knownStatus: number;
  errors: number;
  inputTokens: string | null;
  outputTokens: string | null;
  cachedTokens: string | null;
  cacheWriteTokens: string | null;
  costUsd: string | null;
  cacheRatio: number | null;
  p95DurationMs: number | null;
  p95FirstTokenMs: number | null;
  throttled?: number;
  serverErrors?: number;
  p50DurationMs?: number | null;
  p50FirstTokenMs?: number | null;
  p50LastTokenMs?: number | null;
  p95LastTokenMs?: number | null;
  /** Output tokens per second between the first and the last token. */
  p50TokensPerSecond?: number | null;
  averageCostUsd?: string | null;
  p95CostUsd?: string | null;
  /** Cost of each billing item, by item key. */
  itemCostUsd?: Record<string, string>;
  /** What cache reads saved against paying the input rate for those tokens. */
  cacheSavingsUsd?: string | null;
}
/** Lower bounds, in seconds, of the duration and last-token bins; the last bin is open-ended. */
export const TIME_BIN_EDGES = [0, 2, 5, 10, 20, 30, 60, 120];
/** Lower bounds, in seconds, of the first-token bins; the last bin is open-ended. */
export const FIRST_TOKEN_BIN_EDGES = [0, 0.5, 1, 2, 3, 5, 10, 20];
/** Lower bounds, in output tokens per second, of the speed bins; the last bin is open-ended. */
export const SPEED_BIN_EDGES = [0, 25, 50, 75, 100, 150, 200, 300];
/** Token counts in thousands from 1,000 on, such as 32K and 272K. */
export const thousands = (n: number) => (n >= 1000 ? `${n / 1000}K` : String(n));
/** Lower bounds, in USD, of the cost-per-call bins; the last bin is open-ended. */
export const COST_BIN_EDGES = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
/** Lower bounds, in tokens, of the input bins; 272K is where long-context prices start. */
export const INPUT_BIN_EDGES = [0, 32000, 64000, 96000, 128000, 160000, 200000, 272000];
/** Lower bounds, in tokens, of the output bins; the last bin is open-ended. */
export const OUTPUT_BIN_EDGES = [0, 50, 100, 200, 500, 1000, 2000, 4000];
/** Duration, time to first token, time to last token and generation speed. */
export const PERFORMANCE_MEASURES = ['duration', 'ttft', 'ttlt', 'speed'] as const;
/** Calls that read some of their input from the cache, and calls that read none. */
export const CACHE_HIT_GROUPS = ['nonZero', 'zero'] as const;
export type CacheHitGroup = (typeof CACHE_HIT_GROUPS)[number];
export type PerformanceMeasure = (typeof PERFORMANCE_MEASURES)[number];
/** Every measure whose bins are also counted per model and per resource. */
export const BINNED_MEASURES = [
  ...PERFORMANCE_MEASURES,
  'input',
  'output',
  'context',
  'cost',
] as const;
export type BinnedMeasure = (typeof BINNED_MEASURES)[number];
/** One model's or resource's calls per bin of each measure, in the order of `distributions`. */
export interface MeasureBins {
  name: string;
  counts: Record<BinnedMeasure, number[]>;
}
/** Generation speeds below this many output tokens are dominated by noise and left out. */
const SPEED_MIN_OUTPUT_TOKENS = 100;
/** Output tokens per second between the first and the last token, when the call has enough. */
export function tokensPerSecond(
  fact: Pick<
    import('./ingestion.js').RequestFact,
    'outputTokens' | 'timeToFirstTokenMs' | 'timeToLastTokenMs'
  >,
) {
  const first = fact.timeToFirstTokenMs,
    last = fact.timeToLastTokenMs,
    output = Number(fact.outputTokens ?? 0);
  if (first == null || last == null || last <= first || output < SPEED_MIN_OUTPUT_TOKENS)
    return null;
  return output / ((last - first) / 1000);
}
export interface StackPoint {
  /** Index into `timeline`; buckets without calls for the group are omitted. */
  i: number;
  requests: number;
  errors: number;
  costUsd: string | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cachedTokens: string | null;
  cacheWriteTokens: string | null;
  /** Cost of each billing item, by item key. */
  itemCostUsd: Record<string, string>;
  cacheRatio: number | null;
  /** Percentiles of the group's successful calls in the bucket. */
  p95DurationMs: number | null;
  p95FirstTokenMs: number | null;
  p95LastTokenMs: number | null;
}
export interface StackGroup {
  name: string;
  points: StackPoint[];
}
/**
 * A call as the lists of calls show it, without the rest of its record: the details of a call
 * are fetched when it is opened.
 */
export type CallRow = Pick<
  import('./ingestion.js').RequestFact,
  | 'resourceId'
  | 'correlationId'
  | 'time'
  | 'model'
  | 'operation'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedTokens'
  | 'durationMs'
  | 'timeToFirstTokenMs'
  | 'timeToLastTokenMs'
> & { cost?: { knownUsd: string | null } | null };
/** A group's figures for one model (`name`) within one resource. */
export type InResource<T> = T & { resource: string };
export interface AnalyticsResponse {
  /** `pairs` holds each model within each resource, to break a resource's figures down by model. */
  stacks?: { model: StackGroup[]; resource: StackGroup[]; pairs?: InResource<StackGroup>[] };
  measureBins?: {
    model: MeasureBins[];
    resource: MeasureBins[];
    pairs?: InResource<MeasureBins>[];
  };
  /** Each model within each resource over the whole range. */
  resourceModels?: InResource<{ name: string } & UsageSummary>[];
  generatedAt: string;
  interval?: Interval;
  range?: { from: string; to: string };
  distributions?: Record<string, { name: string; count: number; costUsd: string | null }[]>;
  statuses?: { name: string; count: number }[];
  deployments?: ({ name: string } & UsageSummary)[];
  /** Billed quantity of each billing item; its cost is in `summary.itemCostUsd`. */
  costItems?: { name: string; quantity: string | null }[];
  topCosts?: CallRow[];
  /** Successful calls ranked worst first on each time measure, and by lowest generation speed. */
  slowest?: Record<PerformanceMeasure, CallRow[]>;
  /**
   * Calls with at least 1,024 input tokens: the lowest non-zero cache hit rates, and the calls that
   * read nothing from the cache, each up to 20 with the most uncached input first among equals.
   */
  lowestCache?: Record<CacheHitGroup, CallRow[]>;
  /**
   * This calendar month in the report time zone, whatever the time range: each day's start, the
   * cost so far at each day's end, and the forecast to the month's end, in USD; last month's
   * total, or null without priced calls.
   */
  monthForecast?: {
    days: string[];
    actual: (number | null)[];
    forecast: (number | null)[];
    previous: number | null;
  };
  heatmap?: { day: number; hour: number; requests: number }[];
  /** Totals per calendar day in the report time zone, oldest first. */
  daily?: { date: string; requests: number; costUsd: string | null }[];
  comparison?: UsageSummary;
  /** Sampled calls with both input tokens and time to first token. */
  scatter?: { id: string; model: string; input: number; ttft: number }[];
  timezone: string;
  summary: UsageSummary;
  timeline: ({ date: string } & UsageSummary)[];
  models: ({ name: string } & UsageSummary)[];
  resources: ({ name: string } & UsageSummary)[];
  ips: ({ name: string } & UsageSummary)[];
  facets: { models: string[]; resources: string[]; ips: string[] };
}
