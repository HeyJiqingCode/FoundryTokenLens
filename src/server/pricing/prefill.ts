import {
  emptyPrices,
  priceFields,
  priceTemplate,
  pricePerMillion,
  type RetailPrefillOption,
} from '../../shared/price-form.js';
import { normalizePriceModel, retailModelVersion } from '../../shared/price-identity.js';
import { activeRetailRates } from '../../shared/retail-rates.js';
import type { RetailGroup } from '../../shared/pricing.js';
import { HttpError } from '../http/errors.js';

export function prefillOptions(groups: RetailGroup[], model = '') {
  const fields = priceFields(model);
  let matching = groups.filter(
    (group) => group.deploymentType === 'Global Standard' && group.serviceTier === 'standard',
  );
  if (model) {
    const versions = matching.map((group) => retailModelVersion(model, group.family));
    const latest = versions.sort((a, b) => a.length - b.length || a.localeCompare(b)).at(-1);
    matching = matching.filter((group) => retailModelVersion(model, group.family) === latest);
  }
  const options = new Map<string, RetailPrefillOption>();
  let unsupported = false;
  for (const group of matching) {
    if (
      group.components.some((key) => !(fields as readonly string[]).includes(key)) ||
      (priceTemplate(model) !== 'text' && group.hasContextBands)
    ) {
      unsupported = true;
      continue;
    }
    // Build actual quoted periods; the API does not promise a complete price history.
    const dates = [...new Set(group.rates.map((rate) => rate.validFrom))].sort().reverse();
    for (const date of dates) {
      const tiered = group.rates.some(
        (rate) =>
          rate.band !== 'all' && rate.validFrom <= date && (!rate.validTo || rate.validTo > date),
      );
      const shortRates = activeRetailRates(group.rates, date, tiered ? 'short' : 'all');
      const longRates = tiered ? activeRetailRates(group.rates, date, 'long') : [];
      function pricesFor(rates: typeof shortRates) {
        const prices = emptyPrices(model);
        for (const key of fields) {
          const amounts = new Set(
            rates
              .filter((rate) => rate.component === key)
              .map((rate) => pricePerMillion(rate.unitPriceUsd, rate.unitQuantity)),
          );
          if (amounts.size > 1)
            throw new HttpError(409, 'pricing.retailReturnedMultipleRatesForTheSameMeter');
          if (amounts.size) prices[key] = [...amounts][0];
        }
        return prices;
      }
      const selected = [...shortRates, ...longRates];
      if (!selected.length) continue;
      const prices = pricesFor(shortRates);
      const longPrices = tiered ? pricesFor(longRates) : null;
      const validFrom = selected
        .map((rate) => rate.validFrom)
        .sort()
        .at(-1)!;
      // Only pass through an explicitly returned expiry, never another model's release date.
      const validTo =
        selected.flatMap((rate) => (rate.validTo ? [rate.validTo] : [])).sort()[0] ?? null;
      const signature = JSON.stringify([
        normalizePriceModel(group.family),
        prices,
        longPrices,
        validFrom,
        validTo,
      ]);
      const existing = options.get(signature);
      if (existing) {
        if (!existing.regions.includes(group.region)) existing.regions.push(group.region);
      } else
        options.set(signature, {
          id: `${group.key}:${validFrom}`,
          family: group.family,
          regions: [group.region],
          validFrom,
          validTo,
          prices,
          longPrices,
        });
    }
  }
  if (!options.size && unsupported) throw new HttpError(422, 'pricing.prefillUnsupported');
  return [...options.values()]
    .sort((a, b) => b.validFrom.localeCompare(a.validFrom) || a.id.localeCompare(b.id))
    .slice(0, 2);
}
