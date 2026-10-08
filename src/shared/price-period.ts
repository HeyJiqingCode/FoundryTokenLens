import type { PriceInput } from './settings.js';

/** A null start is earlier than every dated version. */
export function comparePriceStarts(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.localeCompare(b);
}

export function priceAppliesAt(price: Pick<PriceInput, 'validFrom' | 'validTo'>, time: string) {
  return (
    (price.validFrom === null || price.validFrom <= time) &&
    (price.validTo === null || time < price.validTo)
  );
}
