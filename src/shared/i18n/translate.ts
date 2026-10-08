import { catalogs, isMessageKey, type MessageKey } from './catalog.js';
import type { Locale, MessageValue } from './types.js';

export type { MessageKey };
export { isMessageKey };
export type MessageParams = Record<string, string | number | Message>;
export interface Message {
  key: MessageKey;
  params?: MessageParams;
}
export type DisplayMessage = string | Message;

export function message(key: MessageKey, params?: MessageParams): Message {
  return params ? { key, params } : { key };
}

const numbers = {
  'zh-CN': new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 }),
  'en-US': new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 }),
};
const plurals = { 'zh-CN': new Intl.PluralRules('zh-CN'), 'en-US': new Intl.PluralRules('en-US') };

export function translate(key: MessageKey, locale: Locale, params: MessageParams = {}): string {
  const value: MessageValue = catalogs[locale][key];
  if (value === undefined) return key;
  const template =
    typeof value === 'string'
      ? value
      : value[plurals[locale].select(Number(params.count)) === 'one' ? 'one' : 'other'];
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    if (!Object.hasOwn(params, name)) return placeholder;
    const parameter = params[name];
    if (typeof parameter === 'number') return numbers[locale].format(parameter);
    if (typeof parameter === 'object') return translate(parameter.key, locale, parameter.params);
    return parameter;
  });
}

// Raw historical logs and user data stay verbatim; only stable keys are translated.
export function formatSystemMessage(value: DisplayMessage, locale: Locale): string {
  if (typeof value === 'object') return translate(value.key, locale, value.params);
  return isMessageKey(value) ? translate(value, locale) : value;
}
