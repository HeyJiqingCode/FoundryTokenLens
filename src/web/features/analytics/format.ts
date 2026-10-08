import { getLocale, t, type MessageKey } from '../../i18n';
export function usd(value: string | null | undefined) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (number > 0 && number < 0.00000001) return '<$0.00000001';
  return number.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 8,
  });
}
/** Dashboard amounts: cents for normal values, two significant digits below one cent. */
export function money(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number !== 0 && Math.abs(number) < 0.01) return `$${number.toPrecision(2)}`;
  return number.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
export function tokens(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (number >= 1e6) return `${(number / 1e6).toFixed(number >= 1e8 ? 1 : 2)} M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)} K`;
  return Math.round(number).toLocaleString(getLocale());
}
export const ratio = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${(value * 100).toFixed(digits)}%`;
/** A part's share of the whole; tiny non-zero shares stay visible instead of rounding to 0.0%. */
export function share(part: number | string | null, whole: number | string | null) {
  const value = Number(part ?? 0) / Number(whole ?? 0);
  if (!Number.isFinite(value)) return '—';
  return value > 0 && value < 0.001 ? '<0.1%' : ratio(value);
}
export const latency = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`
      : `${Math.round(value)} ms`;
export const count = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : Math.round(value).toLocaleString(getLocale());
export function bytes(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (number < 1024) return `${number.toLocaleString(getLocale())} B`;
  if (number < 1024 ** 2) return `${(number / 1024).toFixed(2)} KiB`;
  if (number < 1024 ** 3) return `${(number / 1024 ** 2).toFixed(2)} MiB`;
  return `${(number / 1024 ** 3).toFixed(3)} GiB`;
}
/** Date and time of a single call, to the second, in the report time zone. */
export const callTimeFormat = (locale: string, timeZone: string) =>
  new Intl.DateTimeFormat(locale, {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
/** Number of calls with its unit, e.g. "1,234 次". */
export const callCount = (value: number) => t('insights.callCount', { count: value });
/** A calendar date such as 2026-09-24, e.g. "Sep 24, 2026". */
export const calendarDay = (date: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { timeZone: 'UTC', dateStyle: 'medium' }).format(
    new Date(`${date}T00:00:00Z`),
  );
/** Short weekday name; the API numbers weekdays from Monday, and 2024-01-01 is a Monday. */
export const weekdayName = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(
    Date.UTC(2024, 0, 1 + day),
  );
/** Hour of day as 00:00–23:00. */
export const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
/** Names a context price band; any band other than `short` is the long-context one. */
export const contextLabel = (band: string): MessageKey =>
  band === 'short'
    ? 'pricing.shortContext'
    : band === 'long'
      ? 'pricing.longContext'
      : 'insights.otherContext';
