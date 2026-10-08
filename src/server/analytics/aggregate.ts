import type { RequestFact } from '../../shared/ingestion.js';
import type { UsageSummary } from '../../shared/analytics.js';
import { moneyString, moneyUnits } from '../pricing/money.js';

const percentile = (values: number[], p: number) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)]
    : null;
export function accumulator() {
  let requests = 0,
    knownStatus = 0,
    errors = 0,
    throttled = 0,
    serverErrors = 0,
    successes = 0;
  const totals = { inputTokens: 0n, outputTokens: 0n, cachedTokens: 0n, cacheWriteTokens: 0n };
  const present = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  let cost = 0n,
    ratioInput = 0n,
    ratioCached = 0n;
  const durations: number[] = [],
    first: number[] = [],
    costs: bigint[] = [];
  return {
    add(row: RequestFact) {
      requests++;
      if (row.hasRequest && row.statusCode !== null && !row.statusConflict) {
        knownStatus++;
        if (row.statusCode >= 400) errors++;
        if (row.statusCode === 429) throttled++;
        if (row.statusCode >= 500) serverErrors++;
        if (row.statusCode >= 200 && row.statusCode < 300) successes++;
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
      if (row.hasRequest && row.durationMs !== null) durations.push(row.durationMs);
      if (row.hasUsage && row.timeToFirstTokenMs !== null) first.push(row.timeToFirstTokenMs);
      if (row.hasUsage && row.cost?.knownUsd != null) {
        const amount = moneyUnits(row.cost.knownUsd);
        cost += amount;
        costs.push(amount);
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
        successes,
        inputTokens: present.inputTokens ? String(totals.inputTokens) : null,
        outputTokens: present.outputTokens ? String(totals.outputTokens) : null,
        cachedTokens: present.cachedTokens ? String(totals.cachedTokens) : null,
        cacheWriteTokens: present.cacheWriteTokens ? String(totals.cacheWriteTokens) : null,
        costUsd: costs.length ? moneyString(cost) : null,
        averageCostUsd: costs.length ? moneyString(cost / BigInt(costs.length)) : null,
        p95CostUsd: costs.length ? moneyString(costs[Math.ceil(costs.length * 0.95) - 1]) : null,
        cacheRatio: ratioInput ? Number((ratioCached * 1000000n) / ratioInput) / 1000000 : null,
        averageDurationMs: durations.length
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : null,
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        p99DurationMs: percentile(durations, 0.99),
        p50FirstTokenMs: percentile(first, 0.5),
        p95FirstTokenMs: percentile(first, 0.95),
      };
    },
  };
}
