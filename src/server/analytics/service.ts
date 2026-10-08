import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { RequestFact } from '../../shared/ingestion.js';
import {
  TOP_SOURCE_IPS,
  type AnalyticsFilters,
  type AnalyticsResponse,
  type UsageSummary,
} from '../../shared/analytics.js';
import { sourceKey } from '../ingestion/parser.js';
import { moneyString, moneyUnits } from '../pricing/money.js';
import { calculateCost } from '../pricing/engine.js';
import { COST_CONTEXTS } from '../../shared/pricing.js';
import { joinedRequests, requestWhere } from './query.js';
import { accumulator } from './aggregate.js';
import {
  DEFAULT_TIME_ZONE,
  bucketStart,
  chooseInterval,
  nextBucket,
} from '../../shared/time-window.js';
import { HttpError } from '../http/errors.js';

export function createAnalyticsService(database: AppDatabase, settings: SettingsRepository) {
  const db = database.connection;
  const cache = new Map<string, { stamp: string; value: AnalyticsResponse }>();
  const sources = () =>
    settings
      .getSources()
      .filter((s) => s.enabled)
      .map(sourceKey);
  function rows(filters: AnalyticsFilters, limit?: number, offset = 0): RequestFact[] {
    const keys = sources(),
      where = requestWhere(filters);
    const prices = settings.listPrices();
    return (
      db
        .prepare(
          `SELECT r.fact_json,c.result_json,r.source_count ${joinedRequests(keys)} WHERE ${where.sql} ORDER BY r.time DESC,r.resource_id,r.correlation_id ${limit === undefined ? '' : 'LIMIT ? OFFSET ?'}`,
        )
        .all(...keys, ...where.params, ...(limit === undefined ? [] : [limit, offset])) as {
        fact_json: string;
        result_json: string | null;
        source_count: number;
      }[]
    ).map((row) => {
      const fact = JSON.parse(row.fact_json) as RequestFact;
      fact.cost =
        row.source_count > 1
          ? calculateCost(fact, prices)
          : row.result_json
            ? JSON.parse(row.result_json)
            : null;
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
  /** Up to about 1000 evenly spaced calls with input tokens and time to first token. */
  function scatter(data: RequestFact[]) {
    const points = data.filter(
      (r) => r.hasUsage && r.inputTokens !== null && r.timeToFirstTokenMs !== null,
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
  function report(filters: AnalyticsFilters): AnalyticsResponse {
    const stamp = database.dataRevision();
    const key = JSON.stringify([sources(), filters]);
    const found = cache.get(key);
    if (found && found.stamp === stamp) return found.value;
    const timezone = filters.timezone ?? DEFAULT_TIME_ZONE;
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
    };
    // Per-bucket accumulators for each group; additive fields sum exactly to the timeline.
    const stacks = {
      model: new Map<string, Map<string, ReturnType<typeof accumulator>>>(),
      resource: new Map<string, Map<string, ReturnType<typeof accumulator>>>(),
    };
    const ips = new Map<string, number>(),
      statuses = new Map<string, number>();
    const items = new Map<
      string,
      { cost: bigint; quantity: bigint; priced: number; known: number }
    >();
    const bin = (...names: string[]) =>
      names.map((name) => ({ name, count: 0, cost: 0n, known: 0 }));
    const bins: Record<string, ReturnType<typeof bin>> = {
      input: bin('0–1K', '1K–8K', '8K–32K', '32K–128K', '128K+'),
      output: bin('0–100', '100–1K', '1K–4K', '4K–16K', '16K+'),
      duration: bin('0–1s', '1–5s', '5–15s', '15–60s', '60s+'),
      ttft: bin('0–0.5s', '0.5–1s', '1–3s', '3–10s', '10s+'),
      cost: bin('$0–0.001', '$0.001–0.01', '$0.01–0.1', '$0.1–1', '$1+'),
      context: bin(...COST_CONTEXTS),
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
      for (const [by, name] of [
        ['model', row.model ?? '—'],
        ['resource', row.resourceId],
      ] as const) {
        if (!stacks[by].has(name)) stacks[by].set(name, new Map());
        const cells = stacks[by].get(name)!;
        if (!cells.has(bucket)) cells.set(bucket, accumulator());
        cells.get(bucket)!.add(row);
      }
      for (const [map, name] of [
        [maps.models, row.model ?? '—'],
        [maps.resources, row.resourceId],
        [maps.deployments, row.deployment ?? '—'],
      ] as const) {
        if (!map.has(name)) map.set(name, accumulator());
        map.get(name)!.add(row);
      }
      addCount(ips, row.callerIp ?? '—');
      addCount(statuses, row.statusConflict ? 'conflict' : String(row.statusCode ?? 'unknown'));
      for (const item of row.hasUsage ? (row.cost?.items ?? []) : []) {
        const v = items.get(item.key) ?? { cost: 0n, quantity: 0n, priced: 0, known: 0 };
        if (item.costUsd !== null) {
          v.cost += moneyUnits(item.costUsd);
          v.priced++;
        }
        if (item.quantity !== null) {
          v.quantity += BigInt(item.quantity);
          v.known++;
        }
        items.set(item.key, v);
      }
      const cost = row.hasUsage ? row.cost?.knownUsd : null;
      const binAdd = (group: string, i: number) => {
        const b = bins[group][i];
        b.count++;
        if (cost != null) {
          b.cost += moneyUnits(cost);
          b.known++;
        }
      };
      if (row.hasUsage && row.inputTokens !== null) {
        const n = Number(row.inputTokens),
          i = [1000, 8000, 32000, 128000].findIndex((x) => n < x);
        binAdd('input', i < 0 ? 4 : i);
      }
      // The context row the billing engine priced the call with, so the bins match the context filter.
      const context = row.cost?.context;
      if (context) binAdd('context', COST_CONTEXTS.indexOf(context));
      if (row.hasUsage && row.outputTokens !== null) {
        const n = Number(row.outputTokens),
          i = [100, 1000, 4000, 16000].findIndex((x) => n < x);
        binAdd('output', i < 0 ? 4 : i);
      }
      for (const [group, value, limits] of [
        ['duration', row.durationMs, [1000, 5000, 15000, 60000]],
        ['ttft', row.timeToFirstTokenMs, [500, 1000, 3000, 10000]],
        ['cost', cost == null ? null : Number(cost), [0.001, 0.01, 0.1, 1]],
      ] as const)
        if (value != null) {
          const i = limits.findIndex((limit) => value < limit);
          binAdd(group, i < 0 ? 4 : i);
        }
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
      if (cost != null) {
        d.cost += moneyUnits(cost);
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
      .filter((row) => row.hasUsage && row.cost?.knownUsd != null)
      .sort((a, b) => {
        const x = moneyUnits(a.cost!.knownUsd!),
          y = moneyUnits(b.cost!.knownUsd!);
        return x > y ? -1 : x < y ? 1 : 0;
      });
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
      stacks: { model: stack(stacks.model), resource: stack(stacks.resource) },
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
        costUsd: v.priced ? moneyString(v.cost) : null,
        quantity: v.known ? String(v.quantity) : null,
      })),
      topCosts: costRows.slice(0, 20),
      slowest: [...data]
        .filter((r) => r.durationMs !== null)
        .sort((a, b) => b.durationMs! - a.durationMs!)
        .slice(0, 20),
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
