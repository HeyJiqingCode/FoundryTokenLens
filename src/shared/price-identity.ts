export const normalizePriceRegion = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

export const modelIdKey = (value: string) => value.trim().toLowerCase();
export const isImageModel = (value: string) => modelIdKey(value).includes('image');

export function normalizePriceModel(value: string) {
  return value
    .toLowerCase()
    .replace(/^gpt[ -]?/, '')
    .replace(/\bimg\b/g, 'image')
    .replace(/[^a-z0-9]/g, '');
}

export function retailFamilyMatches(model: string, family: string, productName?: string) {
  if (productName) {
    const provider = /^(gpt|chatgpt|o\d+)(?:[- ]|$)/i.test(model)
      ? 'openai'
      : /^(deepseek|kimi|grok)(?:[- ]|$)/i.exec(model)?.[1].toLowerCase();
    if (provider && !productName.toLowerCase().includes(provider)) return false;
  }
  const name = normalizePriceModel(model);
  const candidate = normalizePriceModel(family);
  if (name === candidate) return true;
  // Some Azure SKUs append a model release date. Do not match a different model size.
  return candidate.startsWith(name) && /^(?:\d{4}|\d{8})$/.test(candidate.slice(name.length));
}

/** Release suffix within the same model, never the retail price's effective date. */
export function retailModelVersion(model: string, family: string) {
  const name = normalizePriceModel(model);
  const candidate = normalizePriceModel(family);
  return candidate.startsWith(name) ? candidate.slice(name.length) : '';
}
