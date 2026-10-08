import { useVisibility } from './useVisibility';
import type { DisplayMessage } from '../../i18n';
import { useEffect, useState } from 'react';
import {
  INTERVALS,
  TIME_RANGES,
  type AnalyticsResponse,
  type Interval,
  type TimeRange,
} from '../../../shared/analytics';
import { intervalMs, rangeBoundary } from '../../../shared/time-window';
import type { RequestFact } from '../../../shared/ingestion';
import { COST_CONTEXTS, type CostContext } from '../../../shared/pricing';
import { api, errorMessage } from '../../api';
export interface ViewFilters {
  from: string;
  to: string;
  model: string;
  resourceId: string;
  ip: string;
  range?: TimeRange;
  interval?: Interval;
  timezone?: string;
  status?: string;
  context?: CostContext;
  requestId?: string;
}
export const emptyFilters: ViewFilters = {
  from: '',
  to: '',
  model: '',
  resourceId: '',
  ip: '',
};
export const FILTER_KEYS = [
  'from',
  'to',
  'model',
  'resourceId',
  'ip',
  'range',
  'interval',
  'timezone',
  'status',
  'context',
  'requestId',
] as const;
/** The reporting window when the URL names none. */
export const DEFAULT_RANGE: TimeRange = '14d';
/** The relative range in effect, or null when the view uses absolute from/to instants. */
export const presetRange = (filters: ViewFilters) =>
  filters.from || filters.to ? null : (filters.range ?? DEFAULT_RANGE);
function dateValue(value: string | null) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + 'T00:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : '';
  }
  return /^\d{4}-.*T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : '';
}
export function readFilters(query: URLSearchParams): ViewFilters {
  const text = (key: string, max: number) => {
    const v = query.get(key) ?? '';
    return v.length <= max ? v : '';
  };
  const result: ViewFilters = {
    from: dateValue(query.get('from')),
    to: dateValue(query.get('to')),
    model: text('model', 160),
    resourceId: text('resourceId', 2048),
    ip: text('ip', 200),
  };
  const range = query.get('range'),
    interval = query.get('interval');
  if (TIME_RANGES.includes(range as TimeRange)) result.range = range as TimeRange;
  if (INTERVALS.includes(interval as Interval)) result.interval = interval as Interval;
  const zone = text('timezone', 80);
  if (zone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      result.timezone = zone;
    } catch {
      /* Invalid URL timezone falls back to Shanghai. */
    }
  }
  const status = text('status', 40);
  if (status === 'ok' || status === 'error') result.status = status;
  const context = query.get('context');
  if (COST_CONTEXTS.includes(context as CostContext)) result.context = context as CostContext;
  const requestId = text('requestId', 512).trim();
  if (requestId) result.requestId = requestId;
  return result;
}
export function filterSearch(filters: ViewFilters) {
  const query = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) query.set(key, String(value));
  }
  return query.toString();
}
/** API query: the window resolved to instants at `at`, then the remaining filters. */
export function filterQuery(filters: ViewFilters, at = Date.now()) {
  const q = new URLSearchParams();
  const range = presetRange(filters);
  if (range && range !== 'all') {
    q.set('from', new Date(at - intervalMs(range)).toISOString());
    q.set('to', new Date(at).toISOString());
  } else if (!range) {
    if (filters.from) q.set('from', rangeBoundary(filters.from, filters.timezone));
    if (filters.to) q.set('to', rangeBoundary(filters.to, filters.timezone, true));
  }
  for (const key of FILTER_KEYS) {
    if (key === 'from' || key === 'to' || key === 'range') continue;
    if (filters[key]) q.set(key, filters[key]!);
  }
  return q.toString();
}
function useAnalyticsResource<T>(path: string, enabled: boolean, revision: string | number) {
  const visible = useVisibility();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DisplayMessage | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !visible) return;
    const abort = new AbortController();
    setLoading(true);
    void api<T>(path, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) {
          setData(value);
          setError(null);
        }
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    // A request cancelled because the view was disabled or hidden must not leave it loading.
    return () => {
      abort.abort();
      setLoading(false);
    };
  }, [path, enabled, visible, revision]);
  return { data, error, loading };
}
export function useAnalytics(query: string, enabled: boolean, revision: string | number = 0) {
  return useAnalyticsResource<AnalyticsResponse>(`/api/analytics?${query}`, enabled, revision);
}
export type RequestList = { requests: RequestFact[]; total: number };
export const REQUESTS_PAGE_SIZE = 25;
export function useRequests(query: string, page: number, enabled: boolean, revision: string) {
  const offset = (page - 1) * REQUESTS_PAGE_SIZE;
  return useAnalyticsResource<RequestList>(
    `/api/requests?${query}&limit=${REQUESTS_PAGE_SIZE}&offset=${offset}`,
    enabled,
    revision,
  );
}
export function useFacets(enabled: boolean, revision: string | number = 0) {
  return useAnalyticsResource<AnalyticsResponse['facets']>(
    '/api/analytics/facets',
    enabled,
    revision,
  );
}
