import { t, type MessageKey } from '../../i18n';
import type { AnalyticsResponse, StackPoint, UsageSummary } from '../../../shared/analytics';
import { PRICE_LABELS } from '../../../shared/price-form';
import type { ChartSeries } from './charts';
import { count, money, tokens } from './format';
import { METRIC_TONE } from './ui';

export type Metric = 'cost' | 'requests' | 'tokens';
export type StackBy = 'model' | 'resource';

const PALETTE = ['var(--blue)', 'var(--violet)', 'var(--teal)', 'var(--amber)', 'var(--slate)'];
const OTHER_COLOR = 'var(--chart-other)';

/** Colours follow the report's own ranking so an entity keeps its colour on every chart. */
export function entityColors(data: AnalyticsResponse) {
  const colors = new Map<string, string>();
  data.models.forEach((row, i) => colors.set(`model:${row.name}`, PALETTE[i] ?? OTHER_COLOR));
  data.resources.forEach((row, i) => colors.set(`resource:${row.name}`, PALETTE[i] ?? OTHER_COLOR));
  return (by: StackBy, name: string) => colors.get(`${by}:${name}`) ?? OTHER_COLOR;
}

export const resourceName = (id: string) => id.split('/').at(-1) || id;
/** Shown name of a model or resource row; calls without a model are grouped under '—'. */
export function displayName(by: StackBy, name: string) {
  if (by === 'resource') return resourceName(name);
  return name === '—' ? t('analytics.unknownModel') : name;
}
const GROUP_LABELS: Record<StackBy, MessageKey> = {
  model: 'insights.byModel',
  resource: 'insights.byResource',
};
/** Heading of a breakdown's first column, and the label of its switch option. */
export const groupLabel = (by: StackBy) => t(GROUP_LABELS[by]);
/** Options of a breakdown's model/resource switch. */
export const groupOptions = () =>
  (['model', 'resource'] as const).map((value) => ({ value, label: groupLabel(value) }));
/** Options of a chart's split switch: one total, or stacked by model or resource. */
export const splitOptions = () => [
  { value: 'none' as const, label: t('insights.noSplit') },
  ...groupOptions(),
];
/** Rows of a model or resource breakdown, as the API ranks them (by calls). */
export const groupRows = (data: AnalyticsResponse, by: StackBy) =>
  by === 'model' ? data.models : data.resources;
/** The filter a breakdown row applies when clicked; the unknown-model row has none. */
export function rowFilter(
  by: StackBy,
  name: string,
  onFilter: (field: FilterField, value: string) => void,
) {
  if (name === '—') return undefined;
  return () => onFilter(by === 'model' ? 'model' : 'resourceId', name);
}
/** Highest cost first; rows without a price go last, then by calls. */
export const byCost = (a: UsageSummary, b: UsageSummary) =>
  Number(b.costUsd ?? -1) - Number(a.costUsd ?? -1) || b.requests - a.requests;
/** Name of a billing item such as input or cache_read. */
export const billingLabel = (key: string) =>
  Object.hasOwn(PRICE_LABELS, key) ? t(PRICE_LABELS[key as keyof typeof PRICE_LABELS]) : key;

type Additive = Pick<StackPoint, 'requests' | 'costUsd' | 'inputTokens' | 'outputTokens'>;
function metricValue(row: Additive, metric: Metric) {
  if (metric === 'cost') return Number(row.costUsd ?? 0);
  if (metric === 'requests') return row.requests;
  return Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0);
}
export const summaryTokens = (row: Pick<UsageSummary, 'inputTokens' | 'outputTokens'>) =>
  row.inputTokens === null && row.outputTokens === null
    ? null
    : Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0);

/** One total per bucket, named and colored like the overview's chart for the metric. */
export function totalSeries(data: AnalyticsResponse, metric: Metric): ChartSeries[] {
  return [
    {
      key: 'total',
      name: overallTitle(metric),
      color: `var(--${METRIC_TONE[metric]})`,
      values: data.timeline.map((bucket) => metricValue(bucket, metric)),
    },
  ];
}

/** Top groups by the chosen metric; the remainder is summed into one "others" band. */
export function stackSeries(
  data: AnalyticsResponse,
  by: StackBy,
  metric: Metric,
  limit = 5,
): ChartSeries[] {
  const color = entityColors(data);
  const groups = (data.stacks?.[by] ?? [])
    .map((group) => {
      const values = data.timeline.map(() => 0);
      for (const point of group.points) values[point.i] = metricValue(point, metric);
      return {
        key: group.name,
        name: displayName(by, group.name),
        color: color(by, group.name),
        values,
        total: values.reduce((sum, value) => sum + value, 0),
      };
    })
    .filter((group) => group.total > 0)
    .sort((a, b) => b.total - a.total);
  if (groups.length <= limit + 1) return groups;
  const rest = groups.slice(limit);
  return [
    ...groups.slice(0, limit),
    {
      key: '__others__',
      name: t('insights.others'),
      color: OTHER_COLOR,
      values: data.timeline.map((_, i) => rest.reduce((sum, group) => sum + group.values[i], 0)),
    },
  ];
}

/**
 * Prompt tokens split the way they are billed: ordinary input is what remains after cache
 * reads and cache writes, so the stack still adds up to prompt plus output tokens.
 */
export function tokenTypeSeries(data: AnalyticsResponse): ChartSeries[] {
  const value = (v: string | null | undefined) => Number(v ?? 0);
  return [
    {
      key: 'ordinary',
      name: t('insights.input'),
      color: 'var(--blue)',
      values: data.timeline.map((b) =>
        Math.max(0, value(b.inputTokens) - value(b.cachedTokens) - value(b.cacheWriteTokens)),
      ),
    },
    {
      key: 'cacheWrite',
      name: t('insights.cacheWrites'),
      color: 'var(--amber)',
      values: data.timeline.map((b) => value(b.cacheWriteTokens)),
    },
    {
      key: 'cacheRead',
      name: t('insights.cacheRead'),
      color: 'var(--teal)',
      values: data.timeline.map((b) => value(b.cachedTokens)),
    },
    {
      key: 'output',
      name: t('insights.output'),
      color: 'var(--violet)',
      values: data.timeline.map((b) => value(b.outputTokens)),
    },
  ];
}

export function statusSeries(data: AnalyticsResponse): ChartSeries[] {
  return [
    {
      key: '429',
      name: t('insights.throttled'),
      color: 'var(--chart-warning)',
      values: data.timeline.map((b) => b.throttled ?? 0),
    },
    {
      key: '4xx',
      name: t('insights.otherClientErrors'),
      color: 'var(--slate)',
      values: data.timeline.map((b) =>
        Math.max(0, b.errors - (b.throttled ?? 0) - (b.serverErrors ?? 0)),
      ),
    },
    {
      key: '5xx',
      name: t('insights.serverErrors'),
      color: 'var(--danger)',
      values: data.timeline.map((b) => b.serverErrors ?? 0),
    },
  ];
}

/** P95 and P50 call duration per bucket; compact charts name them just P95 and P50. */
export function latencyLines(data: AnalyticsResponse, compact = false) {
  return [
    {
      key: 'p95',
      name: compact ? 'P95' : t('insights.p95Duration'),
      color: 'var(--slate)',
      values: data.timeline.map((b) => b.p95DurationMs),
    },
    {
      key: 'p50',
      name: compact ? 'P50' : t('insights.p50Duration'),
      color: 'var(--chart-other)',
      dashed: true,
      values: data.timeline.map((b) => b.p50DurationMs ?? null),
    },
  ];
}

export const seriesTotal = (series: ChartSeries) =>
  series.values.reduce((sum, value) => sum + value, 0);

/** The calendar day (report time zone) with the highest cost or the most calls, if any. */
export function peakDay(data: AnalyticsResponse, metric: 'cost' | 'requests') {
  let peak: { date: string; value: number } | null = null;
  for (const day of data.daily ?? []) {
    const value = metric === 'cost' ? Number(day.costUsd ?? 0) : day.requests;
    if (value > 0 && (!peak || value > peak.value)) peak = { date: day.date, value };
  }
  return peak;
}
/** Days covered by the report window, used for daily averages. */
export function rangeDays(data: AnalyticsResponse) {
  if (!data.range) return null;
  const days = (Date.parse(data.range.to) - Date.parse(data.range.from)) / 86400000;
  return days > 0 ? days : null;
}
export const errorRate = (row: Pick<UsageSummary, 'errors' | 'knownStatus'>) =>
  row.knownStatus ? row.errors / row.knownStatus : null;

export type FilterField = 'model' | 'resourceId' | 'ip' | 'context';

export const timeAxis = (data: AnalyticsResponse) => ({
  buckets: data.timeline.map((bucket) => bucket.date),
  interval: data.interval ?? '1h',
  timeZone: data.timezone,
});
export const metricLabel = (metric: Metric) =>
  t(
    metric === 'cost'
      ? 'insights.cost'
      : metric === 'requests'
        ? 'insights.calls'
        : 'insights.tokens',
  );
export const metricFormat = (metric: Metric) =>
  metric === 'cost' ? money : metric === 'tokens' ? tokens : count;
/** Titles of the per-bucket totals chart, shared by the overview and the analysis views. */
const OVERALL_TITLES: Record<Metric, MessageKey> = {
  cost: 'insights.overallCost',
  requests: 'insights.callsCount',
  tokens: 'insights.tokens',
};
export const overallTitle = (metric: Metric) => t(OVERALL_TITLES[metric]);
