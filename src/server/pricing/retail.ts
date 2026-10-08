import type { RetailGroup, RetailRate } from '../../shared/pricing.js';
import { hash } from '../ingestion/parser.js';
import { decimal } from './money.js';
import { normalizePriceModel, normalizePriceRegion } from '../../shared/price-identity.js';

export const normalizeRegion = normalizePriceRegion;
export type RetailFetcher = (
  region: string,
  signal: AbortSignal,
) => Promise<Record<string, unknown>[]>;
export const fetchRetailRates: RetailFetcher = async (region, signal) => {
  const url = new URL('https://prices.azure.com/api/retail/prices');
  url.searchParams.set('currencyCode', "'USD'");
  url.searchParams.set(
    '$filter',
    `armRegionName eq '${region}' and priceType eq 'Consumption' and (serviceName eq 'Foundry Models' or contains(productName, 'Azure OpenAI'))`,
  );
  let next: string | null = url.href;
  const visited = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  while (next) {
    const page = new URL(next);
    if (
      page.protocol !== 'https:' ||
      page.hostname !== 'prices.azure.com' ||
      (page.port && page.port !== '443') ||
      page.pathname !== '/api/retail/prices' ||
      page.username ||
      page.password ||
      visited.has(page.href) ||
      visited.size >= 100
    )
      throw new Error('Invalid Retail pagination');
    visited.add(page.href);
    const response = await fetch(page, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Retail request failed');
    const text = await response.text();
    if (text.length > 20 * 1024 * 1024) throw new Error('Retail page too large');
    const data = JSON.parse(text, (key, value, context?: { source: string }) =>
      ['retailPrice', 'unitPrice'].includes(key) && typeof value === 'number'
        ? decimal(context?.source ?? value)
        : value,
    ) as { Items?: Record<string, unknown>[]; NextPageLink?: string | null };
    if (!Array.isArray(data.Items)) throw new Error('Invalid Retail response');
    rows.push(...data.Items);
    next = data.NextPageLink || null;
  }
  return rows;
};

export function decodeRate(row: Record<string, unknown>): RetailRate | null {
  if (
    row.currencyCode !== 'USD' ||
    row.type !== 'Consumption' ||
    Number(row.tierMinimumUnits) !== 0 ||
    row.isPrimaryMeterRegion === false
  )
    return null;
  const sku = String(row.skuName ?? '').replace(/[-_]+/g, ' ');
  const meter = String(row.meterName ?? '');
  const unitMatch = /^(\d+(?:\.\d+)?)\s*([KM])?(?:\s+Tokens?)?$/i.exec(
    String(row.unitOfMeasure ?? '').trim(),
  );
  if (!unitMatch || !/tokens?/i.test(meter)) return null;
  const unit =
    Number(unitMatch[1]) * ({ K: 1000, M: 1000000 }[unitMatch[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isSafeInteger(unit) || unit < 1 || unit > 1000000000) return null;
  let component: string;
  let family = sku;
  const components: [RegExp, string][] = [
    [/\b(?:Cd|Cache(?:d)?)\s*(?:Wr(?:ite)?|Wrt)\b/gi, 'cache_write'],
    [/\b(?:Cd|C{2,3}hd|Cache(?:d)?)\s*(?:Input|Inpt|Inp|Read)\b/gi, 'cache_read'],
    [/\bCached\b/gi, 'cache_read'],
    [/\b(?:Input|Inp|Inpt|In)\b/gi, 'input'],
    [/\b(?:Output|Outpt|Opt|Outp|Out)\b/gi, 'output'],
  ];
  const match = components.find(([pattern]) => pattern.test(sku));
  if (!match) return null;
  component = match[1];
  match[0].lastIndex = 0;
  const direction = match[0].exec(sku)!;
  const before = /\b(txt|text|img|image|aud|audio)\s+$/i.exec(sku.slice(0, direction.index));
  const after = /^\s+(txt|text|img|image|aud|audio)\b/i.exec(
    sku.slice(direction.index + direction[0].length),
  );
  const modality = before ?? after;
  if (modality) {
    const kind = /^(img|image)$/i.test(modality[1])
      ? 'image'
      : /^(aud|audio)$/i.test(modality[1])
        ? 'audio'
        : 'text';
    component += `_${kind}`;
    const start = before ? direction.index - before[0].length : direction.index;
    const end = direction.index + direction[0].length + (after && !before ? after[0].length : 0);
    family = sku.slice(0, start) + sku.slice(end);
  } else if (/\b(?:audio|image|img)\b|rt-aud/i.test(sku)) {
    // Aggregate prompt/output tokens cannot establish a modality-specific quantity.
    component += /audio|rt-aud/i.test(sku) ? '_audio' : '_image';
  }
  match[0].lastIndex = 0;
  family = family.replace(match[0], ' ');
  const band = /\bLongCo\b|\bL$/i.test(sku) ? 'long' : /\bShortCo\b/i.test(sku) ? 'short' : 'all';
  const deploymentType = /\b(?:DZ|DZone|DZn|Data Zone)\b/i.test(sku)
    ? 'Data Zone Standard'
    : /\b(?:Gl|Glbl|Global)\b/i.test(sku)
      ? 'Global Standard'
      : 'Standard';
  const serviceTier = /\bBatch\b/i.test(sku)
    ? 'batch'
    : /\b(?:PP|Prty|Priority)\b/i.test(sku)
      ? 'priority'
      : 'standard';
  family = family
    .replace(
      /\b(?:ShortCo|LongCo|Data Zone|DZ|DZone|DZn|Gl|Glbl|Global|regnl|rgnl|Regional|Batch|PP|Prty|Priority|Std)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (band === 'long') family = family.replace(/\s+L$/i, '');
  // These products omit the provider from the SKU; keep it in the model identity.
  const provider = /^Azure (Deepseek|Kimi|Grok)\b/i.exec(String(row.productName ?? ''))?.[1];
  if (provider) {
    if (provider.toLowerCase() === 'kimi') family = family.replace(/\bThinking\b/gi, '').trim();
    if (!family.toLowerCase().startsWith(provider.toLowerCase())) family = `${provider} ${family}`;
  }
  const region = normalizeRegion(String(row.armRegionName ?? ''));
  if (!family || !region || !row.meterId || !row.effectiveStartDate) return null;
  const validFrom = new Date(String(row.effectiveStartDate));
  if (!Number.isFinite(validFrom.getTime())) return null;
  const end = row.effectiveEndDate ? new Date(String(row.effectiveEndDate)) : null;
  if (end && (!Number.isFinite(end.getTime()) || end <= validFrom)) return null;
  const groupKey = hash(
    JSON.stringify([
      row.productId,
      normalizePriceModel(family),
      region,
      deploymentType,
      serviceTier,
    ]),
  );
  const id = hash(JSON.stringify([row.meterId, region, validFrom.toISOString()]));
  try {
    return {
      id,
      meterId: String(row.meterId),
      groupKey,
      family,
      region,
      deploymentType,
      serviceTier,
      band,
      component,
      unitQuantity: unit,
      unitPriceUsd: decimal(String(row.retailPrice)),
      validFrom: validFrom.toISOString(),
      validTo: end?.toISOString() ?? null,
      meterName: meter,
      productName: String(row.productName),
      skuName: String(row.skuName),
      revision: 1,
    };
  } catch {
    return null;
  }
}

export function decodeCatalog(rows: Record<string, unknown>[]) {
  const decoded = rows.map((row) => ({ row, rate: decodeRate(row) }));
  const known = decoded.flatMap((x) => (x.rate ? [x.rate] : []));
  for (const item of decoded) {
    if (item.rate || !/tokens?/i.test(String(item.row.meterName ?? ''))) continue;
    const sku = String(item.row.skuName ?? '').toLowerCase();
    const prototypes = known
      .filter(
        (r) =>
          r.productName === item.row.productName &&
          r.region === normalizeRegion(String(item.row.armRegionName ?? '')) &&
          sku.startsWith(`${r.family.toLowerCase()} `),
      )
      .sort((a, b) => b.family.length - a.family.length);
    const base = prototypes[0];
    if (!base) continue;
    const suffix = String(item.row.skuName)
      .slice(base.family.length)
      .replace(
        /\b(?:ShortCo|LongCo|Data Zone|DZ|DZone|DZn|Gl|Glbl|Global|regnl|rgnl|Regional|Batch|PP|Prty|Priority|Std)\b/gi,
        '',
      )
      .trim();
    if (!suffix) continue;
    const rate = decodeRate({
      ...item.row,
      skuName: String(item.row.skuName).replace(suffix, 'Inp'),
    });
    if (rate)
      item.rate = {
        ...rate,
        component: `meter_${hash(String(item.row.meterId)).slice(0, 16)}`,
        skuName: String(item.row.skuName),
      };
  }
  return decoded.filter(
    (x): x is { row: Record<string, unknown>; rate: RetailRate } => x.rate !== null,
  );
}
export function groupRates(rates: RetailRate[]): RetailGroup[] {
  const groups = new Map<string, RetailGroup>();
  for (const rate of rates) {
    let group = groups.get(rate.groupKey);
    if (!group) {
      group = {
        key: rate.groupKey,
        family: rate.family,
        region: rate.region,
        deploymentType: rate.deploymentType,
        serviceTier: rate.serviceTier,
        hasContextBands: false,
        components: [],
        rates: [],
      };
      groups.set(rate.groupKey, group);
    }
    group.hasContextBands ||= rate.band !== 'all';
    if (!group.components.includes(rate.component)) group.components.push(rate.component);
    group.rates.push(rate);
  }
  return [...groups.values()].sort(
    (a, b) => a.family.localeCompare(b.family) || a.region.localeCompare(b.region),
  );
}
