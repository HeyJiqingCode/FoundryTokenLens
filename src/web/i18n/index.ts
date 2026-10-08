import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, type Locale } from './locale';
import {
  translate,
  formatSystemMessage,
  type DisplayMessage,
  type MessageKey,
  type MessageParams,
} from '../../shared/i18n/translate';

export { getLocale, setLocale } from './locale';
export {
  translate,
  message,
  isMessageKey,
  type MessageKey,
  type MessageParams,
  type DisplayMessage,
} from '../../shared/i18n/translate';

export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => 'zh-CN' as Locale);
}
export function t(key: MessageKey, params?: MessageParams) {
  return translate(key, getLocale(), params);
}
export function systemMessage(value: DisplayMessage, locale = getLocale()) {
  return formatSystemMessage(value, locale);
}
