import type { Locale } from '../../shared/i18n/types';
export type { Locale } from '../../shared/i18n/types';
const LOCALE_STORAGE_KEY = 'ftl.locale';
const listeners = new Set<() => void>();

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en-US';
}
function initialLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN';
  const url = new URL(window.location.href);
  const fromLink = url.searchParams.get('language');
  if (isLocale(fromLink)) {
    url.searchParams.delete('language');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, fromLink);
    } catch {
      /* Storage is optional. */
    }
    return fromLink;
  }
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* Private browsing may disable storage. */
  }
  return 'zh-CN';
}
let locale = initialLocale();
export const getLocale = () => locale;
export function setLocale(value: Locale) {
  if (!isLocale(value)) return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, value);
  } catch {
    /* Keep this session usable. */
  }
  if (value === locale) return;
  locale = value;
  listeners.forEach((listener) => listener());
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = isLocale(event.newValue) ? event.newValue : 'zh-CN';
    if (next !== locale) {
      locale = next;
      listeners.forEach((listener) => listener());
    }
  });
}
