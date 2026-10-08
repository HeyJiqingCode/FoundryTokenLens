import type { RetailRate } from './pricing.js';

/** A band-specific meter overrides the shared meter, which remains a fallback. */
export function activeRetailRates(rates: RetailRate[], time: string, band?: RetailRate['band']) {
  const selected = new Map<string, RetailRate[]>();
  for (const rate of rates) {
    if (rate.validFrom > time || (band && rate.band !== 'all' && rate.band !== band)) continue;
    const key = `${rate.component}:${band ?? rate.band}`;
    const prior = selected.get(key)?.[0];
    const specific = band && rate.band === band ? 1 : 0;
    const priorSpecific = band && prior?.band === band ? 1 : 0;
    if (
      !prior ||
      specific > priorSpecific ||
      (specific === priorSpecific && rate.validFrom > prior.validFrom)
    )
      selected.set(key, [rate]);
    else if (specific === priorSpecific && rate.validFrom === prior.validFrom)
      selected.get(key)!.push(rate);
  }
  // Apply expiry after selecting the latest rate; an expired replacement must not revive an older quote.
  return [...selected.values()].flat().filter((rate) => !rate.validTo || time < rate.validTo);
}
