import type { RequestFact } from '../../shared/ingestion.js';
import type { CostItem, RequestCost } from '../../shared/pricing.js';
import type { PriceItem, PriceVersion } from '../../shared/settings.js';
import { hash } from '../ingestion/parser.js';
import { charge, moneyString, moneyUnits } from './money.js';
import { modelIdKey, normalizePriceRegion } from '../../shared/price-identity.js';
import { priceAppliesAt } from '../../shared/price-period.js';

export const scopeKey = (
  fact: Pick<RequestFact, 'resourceId' | 'deployment' | 'model' | 'modelVersion'>,
) =>
  hash(
    JSON.stringify([
      fact.resourceId,
      fact.deployment ?? '',
      fact.model ?? '',
      fact.modelVersion ?? '',
    ]),
  );
// Prompt tokens (properties.promptTokens) include the request's cache reads and cache writes,
// and each prompt token is billed at exactly one rate: ordinary input, cache read or cache
// write. Ordinary input is what remains after both cache quantities. A cache quantity the log
// does not report means the request had no such cache activity. Image models split the same
// way per modality.
const NONE = '0';
function remainder(total: string | null, ...parts: string[]) {
  if (total === null) return null;
  const rest = parts.reduce((value, part) => value - BigInt(part), BigInt(total));
  return String(rest > 0n ? rest : 0n);
}
function billedQuantities(fact: RequestFact): Record<string, string | null> {
  const read = fact.cachedTokens ?? NONE;
  const write = fact.cacheWriteTokens ?? NONE;
  const readText = fact.cachedTextTokens ?? NONE;
  const readImage = fact.cachedImageTokens ?? NONE;
  return {
    input: remainder(fact.inputTokens, read, write),
    cache_read: read,
    output: fact.outputTokens,
    cache_write: write,
    input_text: remainder(fact.inputTextTokens ?? null, readText),
    input_image: remainder(fact.inputImageTokens ?? null, readImage),
    cache_read_text: readText,
    cache_read_image: readImage,
    output_image: fact.outputImageTokens ?? null,
  };
}

function calculateItems(
  fact: RequestFact,
  rates: (PriceItem & { reference: string })[],
  base: RequestCost,
): RequestCost {
  const items: CostItem[] = [];
  let known = 0n;
  let priced = 0;
  const quantities = billedQuantities(fact);
  for (const rate of rates) {
    const quantity = Object.hasOwn(quantities, rate.key) ? quantities[rate.key] : null;
    // Each amount = billed quantity × selected unit price ÷ price unit.
    const costUsd =
      quantity === null ? null : charge(quantity, rate.unitPriceUsd, rate.unitQuantity);
    if (costUsd !== null) {
      known += moneyUnits(costUsd);
      priced++;
    }
    items.push({ ...rate, quantity, costUsd, reason: null });
  }
  const complete = rates.length > 0 && priced === rates.length;
  const knownUsd = priced ? moneyString(known) : null;
  return {
    ...base,
    complete,
    status: complete ? 'complete' : 'partial',
    items,
    totalUsd: complete ? knownUsd : null,
    knownUsd,
    reason: null,
  };
}

function selectManualPrice(
  fact: RequestFact,
  manual: PriceVersion[],
): { price: PriceVersion | undefined; ambiguous: boolean } {
  const model = modelIdKey(fact.model ?? '');
  const region = normalizePriceRegion(fact.region ?? '');
  let price: PriceVersion | undefined;
  let priority = -1;
  let ambiguous = false;
  for (const candidate of manual) {
    if (
      modelIdKey(candidate.model) !== model ||
      !priceAppliesAt(candidate, fact.time) ||
      (candidate.modelVersion !== '*' && candidate.modelVersion !== fact.modelVersion) ||
      (candidate.region !== '*' && normalizePriceRegion(candidate.region) !== region) ||
      (candidate.deploymentType !== '*' && candidate.deploymentType !== fact.deploymentType)
    )
      continue;
    const rank = [candidate.modelVersion, candidate.region, candidate.deploymentType].filter(
      (value) => value !== '*',
    ).length;
    if (rank > priority) {
      price = candidate;
      priority = rank;
      ambiguous = false;
    } else if (rank === priority) ambiguous = true;
  }
  return { price, ambiguous };
}

export function calculateCost(
  fact: RequestFact,
  manual: PriceVersion[],
  now = new Date(),
): RequestCost {
  const empty: RequestCost = {
    status: 'missing_price',
    complete: false,
    totalUsd: null,
    knownUsd: null,
    source: null,
    context: null,
    items: [],
    reason: '请求发生时没有适用价格。',
    calculatedAt: now.toISOString(),
  };
  if (fact.timeSource === 'ingestion')
    return { ...empty, status: 'missing_time', reason: '只有日志接收时间，等待请求发生时间。' };
  if (!fact.hasUsage) return { ...empty, status: 'missing_usage', reason: '尚未关联 Usage 日志。' };
  // 1. Select exactly one price version for this model and request time.
  const { price, ambiguous } = selectManualPrice(fact, manual);
  if (price) {
    if (ambiguous)
      return { ...empty, reason: '多个相同优先级的手工价格范围重叠，请缩小适用范围。' };
    // 2. Only promptTokens selects the short/long row; equality is short context.
    const context = price.contextPricing;
    if (context && fact.inputTokens === null)
      return {
        ...empty,
        source: 'manual',
        status: 'partial',
        reason: '缺少输入 Token，不能选择上下文价格分档。',
      };
    const long = context ? BigInt(fact.inputTokens!) > BigInt(context.threshold) : false;
    const items = context && long ? context.longItems : price.items;
    // 3. Price each logged quantity with that row, then sum known amounts.
    return calculateItems(
      fact,
      items.map((item) => ({ ...item, reference: `manual:${price.id}@${price.revision}` })),
      { ...empty, source: 'manual', context: context ? (long ? 'long' : 'short') : 'other' },
    );
  }
  return { ...empty, status: 'pending_mapping', reason: '没有匹配的手工价格，请录入适用价格。' };
}
