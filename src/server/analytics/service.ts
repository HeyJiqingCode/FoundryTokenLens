import { CalendarDate, endOfMonth, parseAbsolute, toZoned } from '@internationalized/date';
import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { RequestFact } from '../../shared/ingestion.js';
import {
  BINNED_MEASURES,
  COST_BIN_EDGES,
  FIRST_TOKEN_BIN_EDGES,
  INPUT_BIN_EDGES,
  OUTPUT_BIN_EDGES,
  SPEED_BIN_EDGES,
  TIME_BIN_EDGES,
  TOP_SOURCE_IPS,
  thousands,
  tokensPerSecond,
  type AnalyticsFilters,
  type AnalyticsResponse,
  type BinnedMeasure,
  type CallRow,
  type UsageSummary,
} from '../../shared/analytics.js';
import { sourceKey } from '../ingestion/parser.js';
import { moneyString, moneyUnits } from '../pricing/money.js';
import { COST_CONTEXTS } from '../../shared/pricing.js';
import { joinedRequests, requestWhere } from './query.js';
import { accumulator, callMoney, succeeded } from './aggregate.js';
import {
  DEFAULT_TIME_ZONE,
  bucketStart,
  chooseInterval,
  nextBucket,
} from '../../shared/time-window.js';
import { HttpError } from '../http/errors.js';

/**
 * Bins from their lower bounds: names such as 2–5s, 32K–64K, $0.01–0.02 or 120s+, each bound
 * written by `label` between `prefix` and `unit`, and each bin's upper bound times `scale`.
 */
const edgeBins = (
  edges: number[],
  { prefix = '', unit = '', label = String, scale = 1 } = {} as {
    prefix?: string;
    unit?: string;
    label?: (edge: number) => string;
    scale?: number;
  },
) => ({
  names: edges.map((edge, i) =>
    i + 1 < edges.length
      ? `${prefix}${label(edge)}–${label(edges[i + 1])}${unit}`
      : `${prefix}${label(edge)}${unit}+`,
  ),
  limits: edges.slice(1).map((edge) => edge * scale),
});
const TIME_BINS = edgeBins(TIME_BIN_EDGES, { unit: 's', scale: 1000 });
const FIRST_TOKEN_BINS = edgeBins(FIRST_TOKEN_BIN_EDGES, { unit: 's', scale: 1000 });
const SPEED_BINS = edgeBins(SPEED_BIN_EDGES);
const INPUT_BINS = edgeBins(INPUT_BIN_EDGES, { label: thousands });
const OUTPUT_BINS = edgeBins(OUTPUT_BIN_EDGES, { label: thousands });
const COST_BINS = edgeBins(COST_BIN_EDGES, { prefix: '$' });

/** The fields of a call that the lists show. */
const callRow = (row: RequestFact): CallRow => ({
  resourceId: row.resourceId,
  correlationId: row.correlationId,
  time: row.time,
  model: row.model,
  operation: row.operation,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cachedTokens: row.cachedTokens,
  durationMs: row.durationMs,
  timeToFirstTokenMs: row.timeToFirstTokenMs,
  timeToLastTokenMs: row.timeToLastTokenMs,
  cost: row.cost && { knownUsd: row.cost.knownUsd },
});

/** The 20 successful calls that rank worst on each time measure and on generation speed. */
function slowest(data: RequestFact[]): NonNullable<AnalyticsResponse['slowest']> {
  const ok = data.filter(succeeded);
  const worst = (value: (row: RequestFact) => number | null | undefined, ascending = false) =>
    ok
      .flatMap((row) => {
        const v = value(row);
        return v == null ? [] : [{ row, v }];
      })
      .sort((a, b) => (ascending ? a.v - b.v : b.v - a.v))
      .slice(0, 20)
      .map(({ row }) => callRow(row));
  return {
    duration: worst((row) => row.durationMs),
    ttft: worst((row) => (row.hasUsage ? row.timeToFirstTokenMs : null)),
    ttlt: worst((row) => (row.hasUsage ? row.timeToLastTokenMs : null)),
    speed: worst((row) => (row.hasUsage ? tokensPerSecond(row) : null), true),
  };
}

/** One model within one resource, as a map key and back. */
const pairKey = (resource: string, model: string) => `${resource}\n${model}`;
function splitPair(key: string) {
  const at = key.indexOf('\n');
  return { resource: key.slice(0, at), name: key.slice(at + 1) };
}

/** Only calls with at least this much input rank by cache hit rate. */
const CACHE_MIN_INPUT_TOKENS = 1024;
/**
 * The 20 lowest non-zero cache hit rates and 20 calls that read nothing from the cache; equal
 * rates put the most uncached input first.
 */
export function lowestCache(data: RequestFact[]): NonNullable<AnalyticsResponse['lowestCache']> {
  const ranked = data
    .flatMap((row) => {
      if (!row.hasUsage || row.inputTokens === null || row.cachedTokens === null) return [];
      const input = Number(row.inputTokens),
        cached = Number(row.cachedTokens);
      return input >= CACHE_MIN_INPUT_TOKENS && cached <= input
        ? [{ row, rate: cached / input, missed: input - cached }]
        : [];
    })
    .sort((a, b) => a.rate - b.rate || b.missed - a.missed);
  const top = (zero: boolean) =>
    ranked
      .filter(({ rate }) => (rate === 0) === zero)
      .slice(0, 20)
      .map(({ row }) => callRow(row));
  return { nonZero: top(false), zero: top(true) };
}

/** The first day of `now`'s month in `timezone`, the instant it starts, and last month's start. */
function monthBounds(now: Date, timezone: string) {
  const local = parseAbsolute(now.toISOString(), timezone);
  const first = new CalendarDate(local.year, local.month, 1);
  return {
    first,
    start: toZoned(first, timezone).toAbsoluteString(),
    previousStart: toZoned(first.subtract({ months: 1 }), timezone).toAbsoluteString(),
  };
}
/**
 * This month day by day in `timezone`: the cost so far at each day's end (today's until `now`),
 * and from now on a forecast that keeps this month's average daily cost to the month's end.
 * `costs` are priced calls; those of last month make up its total.
 */
export function monthForecast(
  costs: { time: string; usd: string }[],
  now: Date,
  timezone: string,
): NonNullable<AnalyticsResponse['monthForecast']> {
  const { first, start, previousStart } = monthBounds(now, timezone);
  const days = Array.from({ length: endOfMonth(first).day }, (_, i) =>
    toZoned(first.add({ days: i }), timezone).toAbsoluteString(),
  );
  const today = parseAbsolute(now.toISOString(), timezone).day - 1;
  const daily = days.map(() => 0n);
  let previous = 0n,
    previousCalls = 0;
  for (const { time, usd } of costs) {
    if (time < previousStart || time > now.toISOString()) continue;
    if (time < start) {
      previous += moneyUnits(usd);
      previousCalls++;
    } else daily[parseAbsolute(time, timezone).day - 1] += moneyUnits(usd);
  }
  let total = 0n;
  const actual = daily.map((cost, i) => {
    total += cost;
    return i > today ? null : Number(moneyString(total));
  });
  const spent = actual[today]!;
  // At least one day, so a few calls in the month's first hours are not stretched over it.
  const elapsed = Math.max(1, (now.getTime() - Date.parse(start)) / 86400000);
  const rate = spent / elapsed;
  return {
    days,
    actual,
    forecast: days.map((_, i) =>
      i < today ? null : i === today ? spent : spent + rate * (i + 1 - elapsed),
    ),
    previous: previousCalls ? Number(moneyString(previous)) : null,
  };
}

export function createAnalyticsService(database: AppDatabase, settings: SettingsRepository) {
  const db = database.connection;
  const cache = new Map<string, { stamp: string; value: AnalyticsResponse }>();
  const forecasts = new Map<string, { stamp: string; value: AnalyticsResponse['monthForecast'] }>();
  const sources = () =>
    settings
      .getSources()
      .filter((s) => s.enabled)
      .map(sourceKey);
  function rows(filters: AnalyticsFilters, limit?: number, offset = 0): RequestFact[] {
    const keys = sources(),
      where = requestWhere(filters);
    return (
      db
        .prepare(
          `SELECT r.fact_json,c.result_json ${joinedRequests(keys)} WHERE ${where.sql} ORDER BY r.time DESC,r.resource_id,r.correlation_id ${limit === undefined ? '' : 'LIMIT ? OFFSET ?'}`,
        )
        .all(...keys, ...where.params, ...(limit === undefined ? [] : [limit, offset])) as {
        fact_json: string;
        result_json: string | null;
      }[]
    ).map((row) => {
      const fact = JSON.parse(row.fact_json) as RequestFact;
      fact.cost = row.result_json ? JSON.parse(row.result_json) : null;
      return fact;
    });
  }
  function requests(filters: AnalyticsFilters, limit = 25, offset = 0) {
    const keys = sources(),
      where = requestWhere(filters);
    return {
      requests: rows(filters, limit, offset),
      total: (
        db
          .prepare(`SELECT count(*) n ${joinedRequests(keys)} WHERE ${where.sql}`)
          .get(...keys, ...where.params) as { n: number }
      ).n,
    };
  }
  // Views hide models that have no computed cost yet; configuring a price and recalculating
  // brings their calls back, including earlier ones.
  let pricedCache: { stamp: string; value: string[] } | undefined;
  function pricedModels(): string[] {
    const keys = sources();
    const stamp = JSON.stringify([keys, database.dataRevision()]);
    if (pricedCache?.stamp === stamp) return pricedCache.value;
    const value = (
      db
        .prepare(
          `SELECT DISTINCT json_extract(r.fact_json,'$.model') model ${joinedRequests(keys)}
          WHERE r.is_inference = 1 AND json_extract(r.fact_json,'$.model') IS NOT NULL
          AND json_extract(c.result_json,'$.knownUsd') IS NOT NULL ORDER BY model`,
        )
        .all(...keys) as { model: string }[]
    ).map((row) => row.model);
    pricedCache = { stamp, value };
    return value;
  }
  let facetCache: { stamp: string; value: AnalyticsResponse['facets'] } | undefined;
  function facets(pricedOnly = false): AnalyticsResponse['facets'] {
    const priced = pricedOnly ? pricedModels() : null;
    const keys = sources();
    const stamp = JSON.stringify([keys, database.dataRevision(), priced]);
    if (facetCache?.stamp === stamp) return facetCache.value;
    const placeholder = keys.map(() => '?').join(',') || "''";
    const scope = !priced
      ? ''
      : priced.length
        ? `AND (is_inference = 0 OR json_extract(fact_json,'$.model') IN (${priced.map(() => '?').join(',')}))`
        : 'AND is_inference = 0';
    const facet = (field: string) =>
      (
        db
          .prepare(
            `SELECT DISTINCT ${field} name FROM request_facts WHERE source_key IN (${placeholder}) AND ${field} IS NOT NULL ${scope} ORDER BY name LIMIT 500`,
          )
          .all(...keys, ...(priced ?? [])) as { name: string }[]
      ).map((r) => r.name);
    const value = {
      models: facet("json_extract(fact_json,'$.model')"),
      resources: facet('resource_id'),
      ips: facet("json_extract(fact_json,'$.callerIp')"),
    };
    facetCache = { stamp, value };
    return value;
  }
  /** Up to about 1000 evenly spaced successful calls with input tokens and time to first token. */
  function scatter(data: RequestFact[]) {
    const points = data.filter(
      (r) => succeeded(r) && r.hasUsage && r.inputTokens !== null && r.timeToFirstTokenMs !== null,
    );
    const step = Math.max(1, Math.ceil(points.length / 1000));
    return points
      .filter((_, i) => i % step === 0)
      .map((r) => ({
        id: `${r.resourceId}/${r.correlationId}`,
        model: r.model ?? '—',
        input: Number(r.inputTokens),
        ttft: r.timeToFirstTokenMs!,
      }));
  }
  /**
   * The month forecast for the filters other than time. It changes with the day, not with the
   * time range, so it is cached apart from the report: per day and data revision.
   */
  function forecast(filters: AnalyticsFilters, timezone: string) {
    const stamp = database.dataRevision(),
      now = new Date();
    const { from: _from, to: _to, interval: _interval, ...scope } = filters;
    const key = JSON.stringify([
      sources(),
      scope,
      timezone,
      bucketStart(now.toISOString(), '1d', timezone),
    ]);
    const found = forecasts.get(key);
    if (found && found.stamp === stamp) return found.value;
    // Priced calls of this month and the last, whatever the time range.
    const keys = sources(),
      where = requestWhere({ ...scope, from: monthBounds(now, timezone).previousStart });
    const costs = db
      .prepare(
        `SELECT r.time time, json_extract(c.result_json,'$.knownUsd') usd ${joinedRequests(keys)}
        WHERE ${where.sql} AND json_extract(r.fact_json,'$.hasUsage')=1 AND json_extract(c.result_json,'$.knownUsd') IS NOT NULL`,
      )
      .all(...keys, ...where.params) as { time: string; usd: string }[];
    const value = monthForecast(costs, now, timezone);
    if (forecasts.size >= 12) forecasts.delete(forecasts.keys().next().value!);
    forecasts.set(key, { stamp, value });
    return value;
  }
  function report(filters: AnalyticsFilters): AnalyticsResponse {
    const stamp = database.dataRevision();
    const key = JSON.stringify([sources(), filters]);
    const timezone = filters.timezone ?? DEFAULT_TIME_ZONE;
    const found = cache.get(key);
    if (found && found.stamp === stamp) {
      // The same report, unless the day, and so the month forecast, has changed since.
      const monthForecast = forecast(filters, timezone);
      if (monthForecast !== found.value.monthForecast)
        found.value = { ...found.value, monthForecast };
      return found.value;
    }
    const data = rows(filters),
      overall = accumulator();
    const first = filters.from ?? data.at(-1)?.time ?? new Date().toISOString();
    const last =
      filters.to ??
      new Date(
        Math.max(Date.now(), ...data.slice(0, 1).map((r) => Date.parse(r.time) + 1)),
      ).toISOString();
    const interval = chooseInterval(
      filters.interval ?? 'auto',
      Date.parse(first),
      Date.parse(last),
    );
    const buckets = new Map<string, ReturnType<typeof accumulator>>();
    let cursor = bucketStart(first, interval, timezone);
    while (Date.parse(cursor) < Date.parse(last)) {
      if (buckets.size >= 12000) throw new HttpError(400, 'analytics.intervalTooFine');
      buckets.set(cursor, accumulator());
      cursor = nextBucket(cursor, interval, timezone);
    }
    const maps = {
      models: new Map<string, ReturnType<typeof accumulator>>(),
      resources: new Map<string, ReturnType<typeof accumulator>>(),
      deployments: new Map<string, ReturnType<typeof accumulator>>(),
      // Each model within each resource, keyed by `pairKey`.
      pairs: new Map<string, ReturnType<typeof accumulator>>(),
    };
    // Per-bucket accumulators for each group; additive fields sum exactly to the timeline.
    const stacks = {
      model: new Map<string, Map<string, ReturnType<typeof accumulator>>>(),
      resource: new Map<string, Map<string, ReturnType<typeof accumulator>>>(),
      pair: new Map<string, Map<string, ReturnType<typeof accumulator>>>(),
    };
    const ips = new Map<string, number>(),
      statuses = new Map<string, number>();
    const items = new Map<string, { quantity: bigint; known: number }>();
    const bin = (...names: string[]) =>
      names.map((name) => ({ name, count: 0, cost: 0n, known: 0 }));
    const bins: Record<BinnedMeasure, ReturnType<typeof bin>> = {
      input: bin(...INPUT_BINS.names),
      output: bin(...OUTPUT_BINS.names),
      duration: bin(...TIME_BINS.names),
      ttft: bin(...FIRST_TOKEN_BINS.names),
      ttlt: bin(...TIME_BINS.names),
      speed: bin(...SPEED_BINS.names),
      cost: bin(...COST_BINS.names),
      context: bin(...COST_CONTEXTS),
    };
    // Every measure's bins per model, per resource and per model within each resource, so the
    // distributions can be split like the charts.
    const measureBins = {
      model: new Map<string, Record<BinnedMeasure, number[]>>(),
      resource: new Map<string, Record<BinnedMeasure, number[]>>(),
      pair: new Map<string, Record<BinnedMeasure, number[]>>(),
    };
    const heat = new Map<string, { day: number; hour: number; requests: number }>();
    const days = new Map<string, { requests: number; cost: bigint; known: number }>();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const addCount = (map: Map<string, number>, name: string) =>
      map.set(name, (map.get(name) ?? 0) + 1);
    for (const row of data) {
      overall.add(row);
      const bucket = bucketStart(row.time, interval, timezone);
      if (!buckets.has(bucket)) buckets.set(bucket, accumulator());
      buckets.get(bucket)!.add(row);
      const groups = [
        ['model', row.model ?? '—'],
        ['resource', row.resourceId],
      ] as const;
      // The models within each resource, so a resource can be broken down by model.
      const crossed = [...groups, ['pair', pairKey(row.resourceId, row.model ?? '—')]] as const;
      for (const [by, name] of crossed) {
        if (!stacks[by].has(name)) stacks[by].set(name, new Map());
        const cells = stacks[by].get(name)!;
        if (!cells.has(bucket)) cells.set(bucket, accumulator());
        cells.get(bucket)!.add(row);
      }
      for (const [map, name] of [
        [maps.models, row.model ?? '—'],
        [maps.resources, row.resourceId],
        [maps.deployments, row.deployment ?? '—'],
        [maps.pairs, pairKey(row.resourceId, row.model ?? '—')],
      ] as const) {
        if (!map.has(name)) map.set(name, accumulator());
        map.get(name)!.add(row);
      }
      addCount(ips, row.callerIp ?? '—');
      addCount(statuses, row.statusConflict ? 'conflict' : String(row.statusCode ?? 'unknown'));
      for (const item of row.hasUsage ? (row.cost?.items ?? []) : []) {
        const v = items.get(item.key) ?? { quantity: 0n, known: 0 };
        if (item.quantity !== null) {
          v.quantity += BigInt(item.quantity);
          v.known++;
        }
        items.set(item.key, v);
      }
      const money = callMoney(row);
      const cost = money && row.cost!.knownUsd;
      const binAdd = (group: BinnedMeasure, i: number) => {
        const b = bins[group][i];
        b.count++;
        // Only the context bands show what their calls cost.
        if (group === 'context' && money) {
          b.cost += money.cost;
          b.known++;
        }
        for (const [by, name] of crossed) {
          if (!measureBins[by].has(name))
            measureBins[by].set(
              name,
              Object.fromEntries(
                BINNED_MEASURES.map((measure) => [measure, bins[measure].map(() => 0)]),
              ) as Record<BinnedMeasure, number[]>,
            );
          measureBins[by].get(name)![group][i]++;
        }
      };
      const binIndex = (value: number, limits: readonly number[]) => {
        const found = limits.findIndex((limit) => value < limit);
        return found < 0 ? limits.length : found;
      };
      if (row.hasUsage && row.inputTokens !== null)
        binAdd('input', binIndex(Number(row.inputTokens), INPUT_BINS.limits));
      // The context row the billing engine priced the call with, so the bins match the context filter.
      const context = row.cost?.context;
      if (context) binAdd('context', COST_CONTEXTS.indexOf(context));
      if (row.hasUsage && row.outputTokens !== null)
        binAdd('output', binIndex(Number(row.outputTokens), OUTPUT_BINS.limits));
      // Duration, token time and speed bins, like every such measure, only count calls that completed.
      const ok = succeeded(row);
      for (const [group, value, limits] of [
        ['duration', ok ? row.durationMs : null, TIME_BINS.limits],
        ['ttft', ok && row.hasUsage ? row.timeToFirstTokenMs : null, FIRST_TOKEN_BINS.limits],
        ['ttlt', ok && row.hasUsage ? row.timeToLastTokenMs : null, TIME_BINS.limits],
        ['speed', ok && row.hasUsage ? tokensPerSecond(row) : null, SPEED_BINS.limits],
        ['cost', cost == null ? null : Number(cost), COST_BINS.limits],
      ] as const)
        if (value != null) binAdd(group, binIndex(value, limits));
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(row.time)).map((p) => [p.type, p.value]),
      );
      const day = weekdays.indexOf(parts.weekday),
        hour = Number(parts.hour),
        hk = `${day}/${hour}`;
      const h = heat.get(hk) ?? { day, hour, requests: 0 };
      h.requests++;
      heat.set(hk, h);
      const date = `${parts.year}-${parts.month}-${parts.day}`;
      const d = days.get(date) ?? { requests: 0, cost: 0n, known: 0 };
      d.requests++;
      if (money) {
        d.cost += money.cost;
        d.known++;
      }
      days.set(date, d);
    }
    const breakdown = (map: Map<string, ReturnType<typeof accumulator>>) =>
      [...map]
        .map(([name, a]) => ({ name, ...a.result() }))
        .sort((a, b) => b.requests - a.requests);
    const bucketIndex = new Map(
      [...buckets.keys()].sort((a, b) => a.localeCompare(b)).map((key, i) => [key, i]),
    );
    const stack = (map: Map<string, Map<string, ReturnType<typeof accumulator>>>) =>
      [...map]
        .map(([name, cells]) => {
          const points = [...cells]
            .map(([key, cell]) => {
              const r = cell.result();
              return {
                i: bucketIndex.get(key)!,
                requests: r.requests,
                errors: r.errors,
                costUsd: r.costUsd,
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
            })
            .sort((a, b) => a.i - b.i);
          return { name, points, requests: points.reduce((sum, p) => sum + p.requests, 0) };
        })
        .sort((a, b) => b.requests - a.requests)
        .map(({ name, points }) => ({ name, points }));
    const ipRows = [...ips].sort((a, b) => b[1] - a[1]).slice(0, TOP_SOURCE_IPS);
    const empty = accumulator().result();
    const costRows = data
      .flatMap((row) => {
        const money = callMoney(row);
        return money ? [{ row, cost: money.cost }] : [];
      })
      .sort((a, b) => (a.cost > b.cost ? -1 : a.cost < b.cost ? 1 : 0))
      .map(({ row }) => row);
    let comparison: UsageSummary | undefined;
    if (filters.from && filters.to) {
      const span = Date.parse(filters.to) - Date.parse(filters.from),
        prev = accumulator();
      for (const row of rows({
        ...filters,
        from: new Date(Date.parse(filters.from) - span).toISOString(),
        to: filters.from,
      }))
        prev.add(row);
      comparison = prev.result();
    }
    const result: AnalyticsResponse = {
      generatedAt: new Date().toISOString(),
      interval,
      timezone,
      range: { from: first, to: last },
      summary: overall.result(),
      comparison,
      timeline: [...buckets]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, a]) => ({ date, ...a.result() })),
      stacks: {
        model: stack(stacks.model),
        resource: stack(stacks.resource),
        pairs: stack(stacks.pair).map(({ name, points }) => ({ ...splitPair(name), points })),
      },
      measureBins: {
        model: [...measureBins.model].map(([name, counts]) => ({ name, counts })),
        resource: [...measureBins.resource].map(([name, counts]) => ({ name, counts })),
        pairs: [...measureBins.pair].map(([key, counts]) => ({ ...splitPair(key), counts })),
      },
      resourceModels: [...maps.pairs].map(([key, a]) => ({ ...splitPair(key), ...a.result() })),
      models: breakdown(maps.models),
      resources: breakdown(maps.resources),
      deployments: breakdown(maps.deployments),
      ips: ipRows.map(([name, requests]) => ({ name, ...empty, requests })),
      statuses: [...statuses].map(([name, count]) => ({ name, count })),
      distributions: Object.fromEntries(
        Object.entries(bins).map(([k, b]) => [
          k,
          b.map((x) => ({
            name: x.name,
            count: x.count,
            costUsd: x.known ? moneyString(x.cost) : null,
          })),
        ]),
      ),
      costItems: [...items].map(([name, v]) => ({
        name,
        quantity: v.known ? String(v.quantity) : null,
      })),
      topCosts: costRows.slice(0, 20).map(callRow),
      slowest: slowest(data),
      lowestCache: lowestCache(data),
      monthForecast: forecast(filters, timezone),
      heatmap: [...heat.values()],
      daily: [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({
          date,
          requests: d.requests,
          costUsd: d.known ? moneyString(d.cost) : null,
        })),
      scatter: scatter(data),
      facets: facets(filters.pricedModels !== undefined),
    };
    if (cache.size >= 12) cache.delete(cache.keys().next().value!);
    cache.set(key, { stamp, value: result });
    return result;
  }
  return {
    requests,
    report,
    facets,
    pricedModels,
  };
}
