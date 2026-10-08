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
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  p95FirstTokenMs: number | null;
  throttled?: number;
  serverErrors?: number;
  successes?: number;
  p50DurationMs?: number | null;
  p99DurationMs?: number | null;
  p50FirstTokenMs?: number | null;
  averageCostUsd?: string | null;
  p95CostUsd?: string | null;
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
}
export interface StackGroup {
  name: string;
  points: StackPoint[];
}
export interface AnalyticsResponse {
  stacks?: { model: StackGroup[]; resource: StackGroup[] };
  generatedAt: string;
  interval?: Interval;
  range?: { from: string; to: string };
  distributions?: Record<string, { name: string; count: number; costUsd: string | null }[]>;
  statuses?: { name: string; count: number }[];
  deployments?: ({ name: string } & UsageSummary)[];
  costItems?: { name: string; costUsd: string | null; quantity: string | null }[];
  topCosts?: import('./ingestion.js').RequestFact[];
  slowest?: import('./ingestion.js').RequestFact[];
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
