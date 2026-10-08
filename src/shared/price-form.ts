import type { PriceItem } from './settings.js';
import { isImageModel } from './price-identity.js';

export const PRICE_UNIT = 1_000_000;
const PRICE_FIELDS = ['input', 'output', 'cache_read', 'cache_write'] as const;
const IMAGE_PRICE_FIELDS = [
  'input_text',
  'input_image',
  'cache_read_text',
  'cache_read_image',
  'output_image',
] as const;
export type PriceField = (typeof PRICE_FIELDS)[number] | (typeof IMAGE_PRICE_FIELDS)[number];
export type FormPrices = Partial<Record<PriceField, string>>;
export const priceTemplate = (model: string) => (isImageModel(model) ? 'image' : 'text');
export const priceFields = (model: string) =>
  isImageModel(model) ? IMAGE_PRICE_FIELDS : PRICE_FIELDS;
export const PRICE_LABELS = {
  input: 'common.input',
  output: 'common.output',
  cache_read: 'pricing.cacheReads',
  cache_write: 'pricing.cacheWrites',
  input_text: 'pricing.textInput',
  input_image: 'pricing.imageInput',
  cache_read_text: 'pricing.textCacheRead',
  cache_read_image: 'pricing.imageCacheRead',
  output_image: 'pricing.imageOutput',
} as const;
export function priceTemplateMatches(model: string, items: PriceItem[], tiered: boolean) {
  const fields: readonly string[] = priceFields(model);
  return (
    !(priceTemplate(model) !== 'text' && tiered) && items.every((item) => fields.includes(item.key))
  );
}
export const emptyPrices = (model = ''): FormPrices =>
  Object.fromEntries(priceFields(model).map((key) => [key, '']));

/** Normalize a quoted rate without floating-point rounding. */
export function pricePerMillion(value: string, unit: number): string {
  if (!/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(value) || !Number.isSafeInteger(unit) || unit < 1)
    throw new Error('Invalid price unit');
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(whole + fraction.padEnd(24, '0')) * BigInt(PRICE_UNIT);
  const denominator = BigInt(unit);
  if (numerator % denominator !== 0n) throw new Error('Price cannot be represented exactly');
  const result = (numerator / denominator).toString().padStart(25, '0');
  const decimal = result.slice(-24).replace(/0+$/, '');
  return `${result.slice(0, -24)}${decimal ? `.${decimal}` : ''}`;
}

export function formPrices(items: PriceItem[], model = ''): FormPrices {
  const values = emptyPrices(model);
  for (const key of priceFields(model)) {
    const item = items.find((item) => item.key === key);
    if (item) values[key] = pricePerMillion(item.unitPriceUsd, item.unitQuantity);
  }
  return values;
}

export interface RetailPrefillOption {
  id: string;
  family: string;
  regions: string[];
  validFrom: string;
  validTo: string | null;
  prices: FormPrices;
  longPrices: FormPrices | null;
}
