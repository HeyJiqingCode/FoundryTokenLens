import { t, type MessageKey } from '../../i18n';
import type {
  AnalyticsResponse,
  StackPoint,
  BinnedMeasure,
  UsageSummary,
} from '../../../shared/analytics';
import { PRICE_LABELS } from '../../../shared/price-form';
import type { ChartPart, ChartSeries } from './charts';
import { callCount, money, tokens } from './format';
import { METRIC_TONE } from './ui';

export type Metric = 'cost' | 'requests' | 'tokens';
export type StackBy = 'model' | 'resource';

const PALETTE = ['var(--blue)', 'var(--violet)', 'var(--teal)', 'var(--amber)', 'var(--slate)'];
const OTHER_COLOR = 'var(--chart-other)';

type TokenFigures = Pick<
  UsageSummary,
  'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens'
>;
const num = (value: string | null | undefined) => Number(value ?? 0);
/** Ordinary input: what remains of the prompt after cache reads and writes, as it is billed. */
const ordinaryInput = (f: TokenFigures) =>
  Math.max(0, num(f.inputTokens) - num(f.cachedTokens) - num(f.cacheWriteTokens));

/** A chart's series and the models listed under them, before the chart colours them. */
type Part = Omit<ChartPart, 'color'>;
type Group = Omit<ChartSeries, 'color' | 'parts'> & { parts?: Part[] };
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
/** The model and resource switch with token or billing type first, as on the token and cost charts. */
export const typeOptions = () => [
  { value: 'type' as const, label: t('insights.byType') },
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
  const value = (point: StackPoint) => metricValue(point, metric);
  return topSeries(
    (data.stacks?.[by] ?? []).map((group) => ({
      key: group.name,
      name: displayName(by, group.name),
      values: bucketValues(data, group.points, value),
      parts:
        by === 'resource'
          ? modelParts(
              inResource(data.stacks?.pairs, group.name).map((pair) => ({
                name: pair.name,
                values: bucketValues(data, pair.points, value),
              })),
            )
          : undefined,
    })),
    limit,
  );
}
/** A group's value in each bucket, 0 where it had no calls. */
function bucketValues(
  data: AnalyticsResponse,
  points: StackPoint[],
  value: (point: StackPoint) => number,
) {
  const values = data.timeline.map(() => 0);
  for (const point of points) values[point.i] = value(point);
  return values;
}
/** Figures of each model within `resource`, from figures listed per model and resource. */
const inResource = <T extends { resource: string }>(rows: T[] | undefined, resource: string) =>
  (rows ?? []).filter((row) => row.resource === resource);
/** Parts named by model, for the tooltip under a resource or type. */
const modelParts = (rows: { name: string; values: number[] }[]) =>
  rows.map((row): Part => ({
    key: row.name,
    name: displayName('model', row.name),
    values: row.values,
  }));
/** Each model's value per bucket, as parts of a series that is not split by model. */
const bucketModelParts = (data: AnalyticsResponse, value: (point: StackPoint) => number) =>
  modelParts(
    (data.stacks?.model ?? []).map((group) => ({
      name: group.name,
      values: bucketValues(data, group.points, value),
    })),
  );

/** Calls per bin of a measure for each model or resource, stacked like `stackSeries`. */
export function binSeries(
  data: AnalyticsResponse,
  by: StackBy,
  measure: BinnedMeasure,
  limit = 5,
): ChartSeries[] {
  return topSeries(
    (data.measureBins?.[by] ?? []).map((group) => ({
      key: group.name,
      name: displayName(by, group.name),
      values: group.counts[measure],
      parts:
        by === 'resource'
          ? modelParts(
              inResource(data.measureBins?.pairs, group.name).map((pair) => ({
                name: pair.name,
                values: pair.counts[measure],
              })),
            )
          : undefined,
    })),
    limit,
  );
}

interface TokenType {
  key: string;
  label: MessageKey;
  /** The billing item these tokens are priced as. */
  item: string;
  color: string;
  value: (f: TokenFigures) => number;
}
/**
 * The billed token types in the order the Token distribution lists them, colored alike in the
 * token and cost charts. Input counts only what remains after cache reads and writes, as it is
 * billed, so the types add up to prompt plus output tokens.
 */
export const TOKEN_TYPES: readonly TokenType[] = [
  {
    key: 'input',
    label: 'insights.input',
    item: 'input',
    color: 'var(--blue)',
    value: ordinaryInput,
  },
  {
    key: 'output',
    label: 'insights.output',
    item: 'output',
    color: 'var(--violet)',
    value: (f) => num(f.outputTokens),
  },
  {
    key: 'cacheRead',
    label: 'insights.cacheRead',
    item: 'cache_read',
    color: 'var(--teal)',
    value: (f) => num(f.cachedTokens),
  },
  {
    key: 'cacheWrite',
    label: 'insights.cacheWrites',
    item: 'cache_write',
    color: 'var(--amber)',
    value: (f) => num(f.cacheWriteTokens),
  },
];
/** A billing item's cost and billed quantity over the report. */
export function billingItem(data: AnalyticsResponse, key: string) {
  return {
    costUsd: data.summary.itemCostUsd?.[key] ?? null,
    quantity: data.costItems?.find((item) => item.name === key)?.quantity ?? null,
  };
}
/**
 * The billing items to list: the four of the token types always, in their order and as 0 when
 * unused, so a new kind of spend appears without code changes; then any other, by cost.
 */
export function billingItems(data: AnalyticsResponse) {
  const standard = TOKEN_TYPES.map((type) => type.item);
  const others = Object.entries(data.summary.itemCostUsd ?? {})
    .filter(([key, cost]) => !standard.includes(key) && Number(cost) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([key]) => key);
  return [...standard, ...others];
}
/** The token types stacked bottom-up in the time charts. */
const STACKED_TYPES = ['input', 'cacheWrite', 'cacheRead', 'output'].map((key) =>
  TOKEN_TYPES.find((type) => type.key === key)!,
);
/** Tokens of each type, in `TOKEN_TYPES` order, for each model or resource. */
export function tokenTypeTotals(data: AnalyticsResponse, by: StackBy, limit = 5): ChartSeries[] {
  const totals = (f: TokenFigures) => TOKEN_TYPES.map((type) => type.value(f));
  return topSeries(
    groupRows(data, by).map((row) => ({
      key: row.name,
      name: displayName(by, row.name),
      values: totals(row),
      parts:
        by === 'resource'
          ? modelParts(
              inResource(data.resourceModels, row.name).map((pair) => ({
                name: pair.name,
                values: totals(pair),
              })),
            )
          : undefined,
    })),
    limit,
  );
}

/** The cost of each of `items`, in that order, for each model or resource. */
export function costItemSeries(
  data: AnalyticsResponse,
  by: StackBy,
  items: readonly string[],
  limit = 5,
): ChartSeries[] {
  return topSeries(
    groupRows(data, by).map((row) => ({
      key: row.name,
      name: displayName(by, row.name),
      values: items.map((item) => Number(row.itemCostUsd?.[item] ?? 0)),
      parts:
        by === 'resource'
          ? modelParts(
              inResource(data.resourceModels, row.name).map((pair) => ({
                name: pair.name,
                values: items.map((item) => Number(pair.itemCostUsd?.[item] ?? 0)),
              })),
            )
          : undefined,
    })),
    limit,
  );
}

const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
/**
 * The largest series by total, coloured by their rank in this chart; the remainder is summed
 * into one grey "others" band.
 */
function topSeries(series: Group[], limit: number): ChartSeries[] {
  const groups = series
    .filter((item) => total(item.values) > 0)
    .sort((a, b) => total(b.values) - total(a.values));
  const rest = groups.length > limit + 1 ? groups.slice(limit) : [];
  const shown = rest.length ? groups.slice(0, limit) : groups;
  return paintParts([
    ...shown.map((group, i) => ({ ...group, color: PALETTE[i] ?? OTHER_COLOR })),
    ...(rest.length
      ? [
          {
            key: '__others__',
            name: t('insights.others'),
            color: OTHER_COLOR,
            values: groups[0].values.map((_, i) =>
              rest.reduce((sum, group) => sum + group.values[i], 0),
            ),
            parts: mergeParts(rest.flatMap((group) => group.parts ?? [])),
          },
        ]
      : []),
  ]);
}
/** The models listed under a chart's series, coloured by their rank across the whole chart. */
function paintParts(series: (Omit<ChartSeries, 'parts'> & { parts?: Part[] })[]): ChartSeries[] {
  const totals = new Map<string, number>();
  for (const item of series)
    for (const part of item.parts ?? [])
      totals.set(part.key, (totals.get(part.key) ?? 0) + total(part.values));
  const ranked = [...totals].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return series.map((item) => ({
    ...item,
    parts: item.parts?.map((part) => ({
      ...part,
      color: PALETTE[ranked.indexOf(part.key)] ?? OTHER_COLOR,
    })),
  }));
}
/** Parts of several series combined, a model's values summed across them. */
function mergeParts(parts: Part[]) {
  if (!parts.length) return undefined;
  const merged = new Map<string, Part>();
  for (const part of parts) {
    const found = merged.get(part.key);
    merged.set(
      part.key,
      found ? { ...found, values: found.values.map((v, i) => v + (part.values[i] ?? 0)) } : part,
    );
  }
  return [...merged.values()];
}

type LineField = 'cacheRatio' | 'p95DurationMs' | 'p95FirstTokenMs' | 'p95LastTokenMs';
/**
 * One line of a ratio or percentile for each of the busiest models or resources. Ratios and
 * percentiles of the remaining groups cannot be combined, so they get no line.
 */
export function groupLines(data: AnalyticsResponse, by: StackBy, field: LineField, limit = 5) {
  // The busiest groups, coloured by that rank.
  return groupRows(data, by)
    .slice(0, limit)
    .map((row, i) => {
      const values: (number | null)[] = data.timeline.map(() => null);
      for (const point of data.stacks?.[by].find((group) => group.name === row.name)?.points ?? [])
        values[point.i] = point[field];
      return { key: row.name, name: displayName(by, row.name), color: PALETTE[i], values };
    });
}

/**
 * Prompt tokens split the way they are billed: ordinary input is what remains after cache
 * reads and cache writes, so the stack still adds up to prompt plus output tokens.
 */
export function tokenTypeSeries(data: AnalyticsResponse): ChartSeries[] {
  return paintParts(
    STACKED_TYPES.map((type) => ({
      key: type.key,
      name: t(type.label),
      color: type.color,
      values: data.timeline.map(type.value),
      parts: bucketModelParts(data, type.value),
    })),
  );
}

/** Cost of each of the billing `items` per bucket, stacked and colored like the token chart. */
export function costTypeSeries(data: AnalyticsResponse, items: readonly string[]): ChartSeries[] {
  const typeOf = (item: string) => STACKED_TYPES.findIndex((type) => type.item === item);
  const rank = (item: string) => (typeOf(item) < 0 ? STACKED_TYPES.length : typeOf(item));
  return paintParts(
    [...items]
      .sort((a, b) => rank(a) - rank(b))
      .map((item) => ({
        key: item,
        name: billingLabel(item),
        color: STACKED_TYPES[typeOf(item)]?.color ?? OTHER_COLOR,
        values: data.timeline.map((bucket) => Number(bucket.itemCostUsd?.[item] ?? 0)),
        parts: bucketModelParts(data, (point) => Number(point.itemCostUsd?.[item] ?? 0)),
      })),
  );
}

export function statusSeries(data: AnalyticsResponse): ChartSeries[] {
  return [
    {
      key: '429',
      name: '429',
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

/** P95 and P50 call duration per bucket, named by percentile only: the chart titles say duration. */
export function latencyLines(data: AnalyticsResponse) {
  return [
    {
      key: 'p95',
      name: 'P95',
      color: 'var(--slate)',
      values: data.timeline.map((b) => b.p95DurationMs),
    },
    {
      key: 'p50',
      name: 'P50',
      color: 'var(--chart-other)',
      dashed: true,
      values: data.timeline.map((b) => b.p50DurationMs ?? null),
    },
  ];
}

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
  metric === 'cost' ? money : metric === 'tokens' ? tokens : callCount;
/** Titles of the per-bucket totals chart, shared by the overview and the analysis views. */
const OVERALL_TITLES: Record<Metric, MessageKey> = {
  cost: 'insights.overallCost',
  requests: 'insights.calls',
  tokens: 'insights.tokens',
};
export const overallTitle = (metric: Metric) => t(OVERALL_TITLES[metric]);
