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
  if (value > 0 && value < 0.001) return '<0.1%';
  return value < 1 && value > 0.999 ? '>99.9%' : ratio(value);
}
/** A duration in ms below a second, in s from there; zero reads 0 s, like the axis ticks above it. */
export const latency = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : value === 0
      ? '0 s'
      : value >= 1000
        ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} s`
        : `${Math.round(value)} ms`;
/** Output tokens per second without the unit; one decimal below 100 unless whole. */
export const speedNumber = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : value >= 100 || Number.isInteger(value)
      ? String(Math.round(value))
      : value.toFixed(1);
/** Generation speed in output tokens per second. */
export const speed = (value: number | null | undefined) =>
  value === null || value === undefined
    ? '—'
    : `${speedNumber(value)} ${t('insights.tokensPerSecond')}`;
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
/**
 * Number of calls for narrow columns: from 1,000 in the locale's short form where it has one
 * ("1.5K calls"), otherwise in full ("1,504 次").
 */
export function shortCallCount(value: number) {
  const short = new Intl.NumberFormat(getLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
  return t('insights.callCount', { count: /\d$/.test(short) ? count(value) : short });
}
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
