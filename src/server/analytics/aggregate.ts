import type { RequestFact } from '../../shared/ingestion.js';
import type { CostItem } from '../../shared/pricing.js';
import { tokensPerSecond, type UsageSummary } from '../../shared/analytics.js';
import { chargeUnits, moneyString, moneyUnits } from '../pricing/money.js';

const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]
    : null;
/** Time measures only count calls that completed: a known status below 400. */
export const succeeded = (row: RequestFact) =>
  row.hasRequest && row.statusCode !== null && row.statusCode < 400 && !row.statusConflict;
/** Each cache-read item, with the input item whose rate its tokens would pay without the cache. */
const UNCACHED: Record<string, string> = {
  cache_read: 'input',
  cache_read_text: 'input_text',
  cache_read_image: 'input_image',
};
/** What the cache saved a call: its cache reads priced at the input rate, less their cost. */
function cacheSavings(items: CostItem[]) {
  let saved = 0n;
  for (const read of items) {
    const input = items.find((item) => item.key === UNCACHED[read.key]);
    if (!input || read.quantity === null || read.costUsd === null) continue;
    saved +=
      chargeUnits(read.quantity, input.unitPriceUsd, input.unitQuantity) - moneyUnits(read.costUsd);
  }
  return saved;
}
interface CallMoney {
  cost: bigint;
  saved: bigint;
  items: [key: string, cost: bigint][];
}
/** Each call's money, parsed once however many sums the call joins. */
const parsedMoney = new WeakMap<RequestFact, CallMoney>();
/** A call's cost, cache savings and billing items in exact units; null without a priced usage. */
export function callMoney(row: RequestFact): CallMoney | null {
  if (!row.hasUsage || row.cost?.knownUsd == null) return null;
  let money = parsedMoney.get(row);
  if (!money) {
    money = {
      cost: moneyUnits(row.cost.knownUsd),
      saved: cacheSavings(row.cost.items),
      items: row.cost.items.flatMap((item): CallMoney['items'] =>
        item.costUsd === null ? [] : [[item.key, moneyUnits(item.costUsd)]],
      ),
    };
    parsedMoney.set(row, money);
  }
  return money;
}
export function accumulator() {
  let requests = 0,
    knownStatus = 0,
    errors = 0,
    throttled = 0,
    serverErrors = 0;
  const totals = { inputTokens: 0n, outputTokens: 0n, cachedTokens: 0n, cacheWriteTokens: 0n };
  const present = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  let cost = 0n,
    saved = 0n,
    ratioInput = 0n,
    ratioCached = 0n;
  const durations: number[] = [],
    first: number[] = [],
    last: number[] = [],
    speeds: number[] = [],
    costs: bigint[] = [];
  const itemCosts = new Map<string, bigint>();
  return {
    add(row: RequestFact) {
      requests++;
      if (row.hasRequest && row.statusCode !== null && !row.statusConflict) {
        knownStatus++;
        if (row.statusCode >= 400) errors++;
        if (row.statusCode === 429) throttled++;
        if (row.statusCode >= 500) serverErrors++;
      }
      if (row.hasUsage)
        for (const key of Object.keys(totals) as (keyof typeof totals)[])
          if (row[key] != null) {
            totals[key] += BigInt(row[key]);
            present[key]++;
          }
      if (
        row.hasUsage &&
        row.inputTokens != null &&
        row.cachedTokens != null &&
        BigInt(row.cachedTokens) <= BigInt(row.inputTokens)
      ) {
        ratioInput += BigInt(row.inputTokens);
        ratioCached += BigInt(row.cachedTokens);
      }
      if (succeeded(row)) {
        if (row.durationMs !== null) durations.push(row.durationMs);
        if (row.hasUsage && row.timeToFirstTokenMs !== null) first.push(row.timeToFirstTokenMs);
        if (row.hasUsage && row.timeToLastTokenMs != null) last.push(row.timeToLastTokenMs);
        const speed = row.hasUsage ? tokensPerSecond(row) : null;
        if (speed !== null) speeds.push(speed);
      }
      const money = callMoney(row);
      if (money) {
        cost += money.cost;
        costs.push(money.cost);
        saved += money.saved;
        for (const [key, units] of money.items)
          itemCosts.set(key, (itemCosts.get(key) ?? 0n) + units);
      }
    },
    result(): UsageSummary {
      costs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        requests,
        knownStatus,
        errors,
        throttled,
        serverErrors,
        inputTokens: present.inputTokens ? String(totals.inputTokens) : null,
        outputTokens: present.outputTokens ? String(totals.outputTokens) : null,
        cachedTokens: present.cachedTokens ? String(totals.cachedTokens) : null,
        cacheWriteTokens: present.cacheWriteTokens ? String(totals.cacheWriteTokens) : null,
        costUsd: costs.length ? moneyString(cost) : null,
        itemCostUsd: Object.fromEntries(
          [...itemCosts].map(([key, units]) => [key, moneyString(units)]),
        ),
        cacheSavingsUsd: costs.length ? moneyString(saved) : null,
        averageCostUsd: costs.length ? moneyString(cost / BigInt(costs.length)) : null,
        p95CostUsd: costs.length ? moneyString(costs[Math.ceil(costs.length * 0.95) - 1]) : null,
        cacheRatio: ratioInput ? Number((ratioCached * 1000000n) / ratioInput) / 1000000 : null,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        p50FirstTokenMs: percentile(first, 0.5),
        p95FirstTokenMs: percentile(first, 0.95),
        p50LastTokenMs: percentile(last, 0.5),
        p95LastTokenMs: percentile(last, 0.95),
        p50TokensPerSecond: percentile(speeds, 0.5),
      };
    },
  };
}
