import {
  parseAbsolute,
  parseDate,
  toZoned,
  CalendarDate,
  CalendarDateTime,
} from '@internationalized/date';
import { INTERVALS, type Interval } from './analytics.js';

export const intervalMs = (value: string): number => {
  const match = /^(\d+)(m|h|d)$/.exec(value);
  return match
    ? Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2] as 'm' | 'h' | 'd']
    : 0;
};
/** Auto picks the interval whose bucket count is closest, by ratio, to this many points. */
const AUTO_POINTS = 30;
export function chooseInterval(
  value: Interval,
  from: number,
  to: number,
): Exclude<Interval, 'auto'> {
  if (value !== 'auto') return value;
  const span = Math.max(to - from, 1);
  const distance = (i: Exclude<Interval, 'auto'>) =>
    Math.abs(Math.log(span / intervalMs(i) / AUTO_POINTS));
  return INTERVALS.filter((i) => i !== 'auto').reduce((best, i) =>
    distance(i) < distance(best) ? i : best,
  );
}
/** Multi-hour intervals such as 6h align to local wall-clock hours (00, 06, 12, 18). */
const localHours = (interval: string) => (/^\d+h$/.test(interval) ? parseInt(interval) : 1);
function localHourStart(time: string, hours: number, zone: string) {
  const local = parseAbsolute(time, zone);
  return new CalendarDateTime(
    local.year,
    local.month,
    local.day,
    local.hour - (local.hour % hours),
  );
}
export function bucketStart(
  time: string,
  interval: Exclude<Interval, 'auto'>,
  zone: string,
): string {
  const step = intervalMs(interval);
  const hours = localHours(interval);
  if (hours > 1) return toZoned(localHourStart(time, hours, zone), zone).toAbsoluteString();
  if (!interval.endsWith('d'))
    return new Date(Math.floor(Date.parse(time) / step) * step).toISOString();
  // The only day interval is 1d: buckets start at local midnight.
  const local = parseAbsolute(time, zone);
  return toZoned(new CalendarDate(local.year, local.month, local.day), zone).toAbsoluteString();
}
export function nextBucket(time: string, interval: Exclude<Interval, 'auto'>, zone: string) {
  const hours = localHours(interval);
  // Wall-clock arithmetic keeps the 00/06/12/18 grid across DST changes.
  if (hours > 1)
    return toZoned(localHourStart(time, hours, zone).add({ hours }), zone).toAbsoluteString();
  return interval.endsWith('d')
    ? parseAbsolute(time, zone)
        .add({ days: Number(interval.slice(0, -1)) })
        .toAbsoluteString()
    : new Date(Date.parse(time) + intervalMs(interval)).toISOString();
}

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';
export function rangeBoundary(value: string, zone = DEFAULT_TIME_ZONE, end = false): string {
  if (value.includes('T')) return new Date(value).toISOString();
  const date = parseDate(value);
  return toZoned(end ? date.add({ days: 1 }) : date, zone).toAbsoluteString();
}
