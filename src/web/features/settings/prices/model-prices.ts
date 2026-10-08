import type { DetectedModel, PriceModelIdentity } from '../../../../shared/pricing';
import type { PriceItem, PriceVersion } from '../../../../shared/settings';
import { modelIdKey, normalizePriceRegion } from '../../../../shared/price-identity';
import { PRICE_LABELS, pricePerMillion } from '../../../../shared/price-form';
import { comparePriceStarts, priceAppliesAt } from '../../../../shared/price-period';
import { DEFAULT_TIME_ZONE } from '../../../../shared/time-window';
import { getLocale, t, type MessageKey } from '../../../i18n';

export interface ModelPrices {
  name: string;
  displayName?: string;
  fromLogs?: boolean;
  scopes: DetectedModel[];
  prices: PriceVersion[];
}
export function modelTitle(model: string) {
  return model
    .split('-')
    .map((part) => (/^gpt$/i.test(part) ? 'GPT' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}
export function modelProvider(model: string): 'openai' | null {
  if (
    /^(?:gpt(?:-|$)|chatgpt(?:-|$)|o\d+(?:-|$)|text-embedding-|dall-e(?:-|$)|whisper(?:-|$)|tts(?:-|$))/i.test(
      model,
    )
  )
    return 'openai';
  return null;
}
export const meterLabels: Record<string, MessageKey> = PRICE_LABELS;

export function modelPrices(
  scopes: DetectedModel[],
  prices: PriceVersion[],
  excludedModels: string[] = [],
  identities: PriceModelIdentity[] = [],
) {
  const models = new Map<string, ModelPrices>();
  function get(name: string) {
    const key = name.toLowerCase();
    if (!models.has(key)) {
      const identity = identities.find((item) => modelIdKey(item.model) === key);
      models.set(key, {
        name,
        displayName: identity?.displayName ?? undefined,
        fromLogs: identity?.fromLogs,
        scopes: [],
        prices: [],
      });
    }
    return models.get(key)!;
  }
  for (const scope of scopes) get(scope.model).scopes.push(scope);
  for (const price of prices) get(price.model).prices.push(price);
  for (const model of models.values())
    model.prices.sort((a, b) => comparePriceStarts(b.validFrom, a.validFrom));
  const excluded = new Set(excludedModels.map((model) => model.toLowerCase()));
  return [...models.values()]
    .filter((model) => !excluded.has(model.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}
type PriceBandKind = 'all' | 'short' | 'long';
export type PriceValues = Record<string, string[]>;
interface PriceBandSummary {
  kind: PriceBandKind;
  values: PriceValues;
  threshold?: string;
}
function itemValues(items: PriceItem[]): PriceValues {
  const values: PriceValues = {};
  for (const item of items) (values[item.key] ??= []).push(perMillion(item));
  return values;
}
export function manualPriceBands(price: PriceVersion): PriceBandSummary[] {
  return price.contextPricing
    ? [
        {
          kind: 'short',
          values: itemValues(price.items),
          threshold: price.contextPricing.threshold,
        },
        {
          kind: 'long',
          values: itemValues(price.contextPricing.longItems),
          threshold: price.contextPricing.threshold,
        },
      ]
    : [{ kind: 'all', values: itemValues(price.items) }];
}
export function perMillion(item: Pick<PriceItem, 'unitPriceUsd' | 'unitQuantity'>) {
  return pricePerMillion(item.unitPriceUsd, item.unitQuantity);
}
export function rateRange(values: string[]) {
  if (!values.length) return '—';
  const units = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(24, '0'));
  };
  const sorted = [...values].sort((a, b) =>
    units(a) < units(b) ? -1 : units(a) > units(b) ? 1 : 0,
  );
  const format = (value: string) => {
    const [whole, fraction] = value.split('.');
    return BigInt(whole).toLocaleString(getLocale()) + (fraction ? '.' + fraction : '');
  };
  return sorted[0] === sorted.at(-1)
    ? format(sorted[0])
    : `${format(sorted[0])}–${format(sorted.at(-1)!)}`;
}
export function dateLabel(value: string) {
  return new Date(value).toLocaleDateString(getLocale(), {
    timeZone: DEFAULT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
export function periodLabel(from: string | null, to: string | null) {
  if (from === null && to === null) return t('pricing.alwaysValid');
  if (from === null) return t('pricing.endsOnDate', { date: dateLabel(to!) });
  if (to === null) return t('pricing.startsOnDate', { date: dateLabel(from) });
  return `${dateLabel(from)} — ${dateLabel(to)}`;
}
export function versionStatus(price: Pick<PriceVersion, 'validFrom' | 'validTo'>): MessageKey {
  const now = new Date().toISOString();
  return price.validFrom !== null && price.validFrom > now
    ? 'pricing.futureVersion'
    : price.validTo && price.validTo <= now
      ? 'pricing.pastVersion'
      : 'pricing.currentVersion';
}
export function modelSummary(model: ModelPrices, now = new Date().toISOString()) {
  const bandValues: Record<PriceBandKind, PriceValues> = { all: {}, short: {}, long: {} };
  const periods = new Set<string>();
  function add(bands: PriceBandSummary[], from: string | null, to: string | null) {
    periods.add(periodLabel(from, to));
    for (const band of bands)
      for (const [key, values] of Object.entries(band.values))
        (bandValues[band.kind][key] ??= []).push(...values);
  }
  const active = model.prices.filter((price) => priceAppliesAt(price, now));
  if (!model.scopes.length)
    for (const price of active) add(manualPriceBands(price), price.validFrom, price.validTo);
  for (const scope of model.scopes) {
    // Prices entered in the editor apply to every deployment type, so only version and region narrow them.
    const matches = active.filter(
      (price) =>
        (price.modelVersion === '*' || price.modelVersion === scope.modelVersion) &&
        (price.region === '*' ||
          normalizePriceRegion(price.region) === normalizePriceRegion(scope.region)),
    );
    const specificity = (price: PriceVersion) =>
      [price.modelVersion, price.region].filter((value) => value !== '*').length;
    matches.sort((a, b) => specificity(b) - specificity(a));
    const [best, next] = matches;
    // Equally specific prices are ambiguous, so the scope has no price.
    if (best && (!next || specificity(best) > specificity(next)))
      add(manualPriceBands(best), best.validFrom, best.validTo);
  }
  const tiered =
    Object.keys(bandValues.short).length > 0 || Object.keys(bandValues.long).length > 0;
  const bands: PriceBandSummary[] = (tiered ? (['short', 'long'] as const) : (['all'] as const))
    .map((kind) => {
      const values: PriceValues = {};
      for (const bucket of kind === 'all' ? [bandValues.all] : [bandValues.all, bandValues[kind]])
        for (const [key, rates] of Object.entries(bucket)) (values[key] ??= []).push(...rates);
      return { kind, values };
    })
    .filter((band) => tiered || Object.keys(band.values).length > 0);
  return {
    bands,
    period:
      periods.size === 1 ? [...periods][0] : periods.size ? t('pricing.multiplePeriods') : '—',
  };
}
