import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Dialog as RacDialog } from 'react-aria-components';
import { CalendarDays, FunnelX, RefreshCw, Search, X } from 'lucide-react';
import { now, parseAbsolute, toTimeZone } from '@internationalized/date';
import {
  INTERVALS,
  TIME_RANGES,
  type AnalyticsResponse,
  type Interval,
  type TimeRange,
} from '../../../shared/analytics';
import { DEFAULT_TIME_ZONE, intervalMs, rangeBoundary } from '../../../shared/time-window';
import { DateTimeField } from '../../components/date-time/DateTimeField';
import { PickerPopover } from '../../components/date-time/PickerPopover';
import { FilterSelect } from '../../components/FilterSelect';
import { TimeZoneField } from '../../components/date-time/TimeZoneField';
import { t, translate, useLocale, type MessageKey } from '../../i18n';
import { DEFAULT_RANGE, emptyFilters, presetRange, type ViewFilters } from './useAnalytics';
import { resourceName } from './series';
import { contextLabel } from './format';
import { COST_CONTEXTS, type CostContext } from '../../../shared/pricing';

const QUICK_RANGES = [
  { range: '1d', label: 'insights.range24h' },
  { range: '7d', label: 'insights.range7d' },
  { range: '14d', label: 'insights.range14d' },
  { range: '30d', label: 'insights.range30d' },
] as const;
const RANGE_LABELS: Record<TimeRange, MessageKey> = {
  '30m': 'analytics.last30Minutes',
  '1h': 'analytics.lastHour',
  '4h': 'analytics.last4Hours',
  '12h': 'analytics.last12Hours',
  '1d': 'analytics.last24Hours',
  '48h': 'analytics.last48Hours',
  '3d': 'analytics.last3Days',
  '7d': 'analytics.last7Days',
  '14d': 'analytics.last14Days',
  '30d': 'analytics.last30Days',
  all: 'analytics.allTime',
};
const INTERVAL_LABELS: Record<Exclude<Interval, 'auto'>, MessageKey> = {
  '1m': 'analytics.oneMinute',
  '5m': 'analytics.fiveMinutes',
  '15m': 'analytics.fifteenMinutes',
  '30m': 'analytics.thirtyMinutes',
  '1h': 'analytics.oneHour',
  '6h': 'analytics.sixHours',
  '12h': 'analytics.twelveHours',
  '1d': 'analytics.oneDay',
};
export const intervalLabel = (value: string) =>
  value in INTERVAL_LABELS ? t(INTERVAL_LABELS[value as keyof typeof INTERVAL_LABELS]) : value;

/**
 * A window in the report time zone, e.g. "Sep 21, 2026, 19:00 – Sep 28, 2026, 19:00"; `numeric`
 * months match the date fields: "2026/9/22 12:23 – …".
 */
export function rangeText(
  from: string | null,
  to: string | null,
  timeZone: string,
  locale: string,
  month: 'short' | 'numeric' = 'short',
) {
  if (!from) return t('analytics.allTime');
  const format = new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month,
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${format.format(new Date(from))} – ${to ? format.format(new Date(to)) : '…'}`;
}

type ResolvedWindow = { from: string | null; to: string | null };

/** Reporting window: quick ranges (the default range preselected) and the full range dropdown. */
function TimeRangeControls({
  value,
  onChange,
  resolvedWindow,
}: {
  value: ViewFilters;
  onChange: (value: ViewFilters) => void;
  resolvedWindow: ResolvedWindow;
}) {
  const locale = useLocale();
  const bar = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const zone = value.timezone ?? DEFAULT_TIME_ZONE;
  const preset = presetRange(value);
  const quick = QUICK_RANGES.some((item) => item.range === preset);
  // Every window other than a quick range, preset or custom, shows the dates it resolves to.
  const customLabel = quick
    ? t('insights.customRange')
    : rangeText(resolvedWindow.from, resolvedWindow.to, zone, locale, 'numeric');
  // Any other window fills the whole bar in place of the quick ranges; the bar keeps its default
  // width, measured on a hidden copy, so choosing a window never shifts the toolbar.
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (quick) {
      setWidth(null);
      return;
    }
    const copy = sizer.current!;
    const measure = () => setWidth(copy.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(copy);
    return () => observer.disconnect();
  }, [quick]);
  const quickButton = (item: (typeof QUICK_RANGES)[number], sizing: boolean) => (
    <button
      key={item.range}
      type="button"
      hidden={!sizing && !quick}
      aria-pressed={sizing ? item.range === DEFAULT_RANGE : preset === item.range}
      onClick={() => onChange({ ...value, range: item.range, from: '', to: '', timezone: zone })}
    >
      {t(item.label)}
    </button>
  );
  return (
    <div className="data-time" aria-label={t('analytics.timeRange')} role="group">
      <div
        className={`segmented${quick ? '' : ' range-window'}`}
        ref={bar}
        style={width ? { width } : undefined}
      >
        {QUICK_RANGES.map((item) => quickButton(item, false))}
        <button
          type="button"
          className="range-custom"
          aria-pressed={!quick}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={quick ? undefined : customLabel}
          onClick={() => setOpen(true)}
        >
          <CalendarDays size={14} aria-hidden="true" />
          <span>{customLabel}</span>
        </button>
      </div>
      {/* The default look of the bar, only to measure its width. */}
      <div className="segmented range-sizer" ref={sizer} aria-hidden="true" inert>
        {QUICK_RANGES.map((item) => quickButton(item, true))}
        <button type="button">
          <CalendarDays size={14} aria-hidden="true" />
          <span>{t('insights.customRange')}</span>
        </button>
      </div>
      {/* Anchored to the whole bar so the dropdown matches its width. */}
      <PickerPopover
        triggerRef={bar}
        isOpen={open}
        onOpenChange={setOpen}
        placement="bottom end"
        className="range-popover"
      >
        <RacDialog aria-label={t('analytics.timeRange')} className="range-panel">
          <TimeRangePanel value={value} onChange={onChange} onClose={() => setOpen(false)} />
        </RacDialog>
      </PickerPopover>
    </div>
  );
}

const CUSTOM = 'custom';
const RANGE_CHOICES = [...TIME_RANGES, CUSTOM] as const;
function TimeRangePanel({
  value,
  onChange,
  onClose,
}: {
  value: ViewFilters;
  onChange: (value: ViewFilters) => void;
  onClose: () => void;
}) {
  const zone = value.timezone ?? DEFAULT_TIME_ZONE;
  const preset = presetRange(value);
  // A custom range starts from the span currently shown ("all" has none, so the default).
  const span = intervalMs(preset ?? '') || intervalMs(DEFAULT_RANGE);
  const [choice, setChoice] = useState<TimeRange | typeof CUSTOM>(preset ?? CUSTOM);
  const [draftZone, setZone] = useState(zone);
  const [from, setFrom] = useState(() =>
    value.from
      ? parseAbsolute(rangeBoundary(value.from, zone), zone)
      : now(zone).subtract({ milliseconds: span }),
  );
  const [to, setTo] = useState(() =>
    value.to ? parseAbsolute(rangeBoundary(value.to, zone, true), zone) : now(zone),
  );
  const custom = choice === CUSTOM;
  return (
    <>
      <div
        className="range-options"
        role="radiogroup"
        aria-label={t('analytics.timeRange')}
        style={{ '--rows': Math.ceil(RANGE_CHOICES.length / 2) } as CSSProperties}
      >
        {RANGE_CHOICES.map((range) => (
          <label className="checkbox-label" key={range}>
            <input
              type="radio"
              name="time-range"
              checked={choice === range}
              onChange={() => setChoice(range as TimeRange | typeof CUSTOM)}
            />
            {range === CUSTOM ? t('analytics.customRange') : t(RANGE_LABELS[range as TimeRange])}
          </label>
        ))}
      </div>
      {custom && (
        <div className="range-custom-fields">
          <TimeZoneField
            value={draftZone}
            onChange={(next) => {
              setZone(next);
              setFrom(toTimeZone(from, next));
              setTo(toTimeZone(to, next));
            }}
          />
          <DateTimeField
            name="rangeFrom"
            label={t('common.startTime')}
            value={from}
            onChange={(v) => v && setFrom(v)}
            timeZone={draftZone}
          />
          <DateTimeField
            name="rangeTo"
            label={t('common.endTime')}
            value={to}
            onChange={(v) => v && setTo(v)}
            timeZone={draftZone}
          />
        </div>
      )}
      <div className="range-actions">
        <button type="button" className="button secondary toolbar-button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="button primary toolbar-button"
          disabled={custom && from.compare(to) >= 0}
          onClick={() => {
            onChange(
              custom
                ? {
                    ...value,
                    range: undefined,
                    from: from.toAbsoluteString(),
                    to: to.toAbsoluteString(),
                    timezone: draftZone,
                  }
                : { ...value, range: choice, from: '', to: '', timezone: zone },
            );
            onClose();
          }}
        >
          {t('analytics.apply')}
        </button>
      </div>
    </>
  );
}

const withCurrent = (values: string[], current: string) =>
  current && !values.includes(current) ? [current, ...values] : values;

/** Whether the view differs from the default: default window, automatic granularity, no filters. */
const hasFilters = (value: ViewFilters) =>
  presetRange(value) !== DEFAULT_RANGE ||
  (value.interval ?? 'auto') !== 'auto' ||
  Boolean(
    value.model || value.resourceId || value.ip || value.status || value.context || value.requestId,
  );

/** Toolbar under the page title: filters, then granularity and the reporting window on the right; the window summary below. */
export function DataToolbar({
  value,
  onChange,
  facets,
  resolvedInterval,
  resolvedWindow,
  showInterval = true,
  meta,
  children,
}: {
  value: ViewFilters;
  onChange: (value: ViewFilters) => void;
  facets?: AnalyticsResponse['facets'];
  resolvedInterval?: string;
  /** The from/to the current filters query, as sent to the API; no from means all time. */
  resolvedWindow: ResolvedWindow;
  showInterval?: boolean;
  meta: ReactNode;
  children?: ReactNode;
}) {
  useLocale();
  const set = (patch: Partial<ViewFilters>) => onChange({ ...value, ...patch });
  return (
    <div className="data-toolbar">
      <div className="filter-row" role="group" aria-label={t('analytics.dataFilters')}>
        <FilterSelect
          label={t('insights.filterModel')}
          value={value.model}
          options={withCurrent(facets?.models ?? [], value.model).map((id) => ({ id, label: id }))}
          onChange={(model) => set({ model })}
        />
        <FilterSelect
          label={t('insights.filterResource')}
          value={value.resourceId}
          options={withCurrent(facets?.resources ?? [], value.resourceId).map((id) => ({
            id,
            label: resourceName(id),
          }))}
          onChange={(resourceId) => set({ resourceId })}
        />
        <FilterSelect
          label={t('insights.filterStatus')}
          value={value.status ?? ''}
          options={[
            { id: 'ok', label: t('insights.okRequests') },
            { id: 'error', label: t('insights.errorRequests') },
          ]}
          onChange={(status) => set({ status })}
        />
        <FilterSelect
          label={t('insights.filterContext')}
          value={value.context ?? ''}
          options={COST_CONTEXTS.map((id) => ({ id, label: t(contextLabel(id)) }))}
          onChange={(context) =>
            set({ context: (context || undefined) as CostContext | undefined })
          }
        />
        <FilterSelect
          label={t('insights.filterIp')}
          value={value.ip}
          options={withCurrent(facets?.ips ?? [], value.ip).map((id) => ({ id, label: id }))}
          onChange={(ip) => set({ ip })}
        />
        {children}
        <div className="filter-row-end">
          {showInterval && (
            <FilterSelect
              label={t('insights.granularity')}
              value={value.interval ?? 'auto'}
              fallback="auto"
              allOption={false}
              display={
                (value.interval ?? 'auto') === 'auto'
                  ? `${t('analytics.autoInterval')}${resolvedInterval ? ` · ${intervalLabel(resolvedInterval)}` : ''}`
                  : undefined
              }
              options={INTERVALS.map((id) => ({
                id,
                label: id === 'auto' ? t('analytics.autoInterval') : intervalLabel(id),
              }))}
              onChange={(interval) => set({ interval: (interval || 'auto') as Interval })}
            />
          )}
          <TimeRangeControls value={value} onChange={onChange} resolvedWindow={resolvedWindow} />
        </div>
      </div>
      <p className="data-meta">{meta}</p>
    </div>
  );
}

export function RefreshButton({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <button
      type="button"
      className={`button secondary toolbar-button${loading ? ' spinning' : ''}`}
      aria-busy={loading}
      onClick={onRefresh}
    >
      <RefreshCw size={14} aria-hidden="true" />
      {t('analytics.refresh')}
    </button>
  );
}

/** Restores the default view (default range, automatic granularity, no filters); keeps the time zone. */
export function ClearFiltersButton({
  value,
  onChange,
}: {
  value: ViewFilters;
  onChange: (value: ViewFilters) => void;
}) {
  return (
    <button
      type="button"
      className="button secondary toolbar-button"
      disabled={!hasFilters(value)}
      onClick={() => onChange({ ...emptyFilters, timezone: value.timezone })}
    >
      <FunnelX size={14} aria-hidden="true" />
      {t('insights.clearFilters')}
    </button>
  );
}

export function RequestIdSearch({
  value,
  onChange,
}: {
  value: ViewFilters;
  onChange: (value: ViewFilters) => void;
}) {
  const current = value.requestId ?? '';
  const [draft, setDraft] = useState(current);
  const [synced, setSynced] = useState(current);
  if (synced !== current) {
    setSynced(current);
    setDraft(current);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onChange({ ...value, requestId: draft.trim() });
  }
  return (
    <form className="search-box request-id-search" role="search" onSubmit={submit}>
      <Search size={14} aria-hidden="true" />
      {/* The hidden English prompt sizes the field, so it shows in full in every language and font. */}
      <span className="request-id-field">
        <span aria-hidden="true">{translate('insights.searchRequestId', 'en-US')}</span>
        <input
          type="search"
          size={1}
          value={draft}
          maxLength={512}
          spellCheck={false}
          placeholder={t('insights.searchRequestId')}
          aria-label={t('insights.searchRequestId')}
          onChange={(event) => setDraft(event.target.value)}
        />
      </span>
      {current && (
        <button
          type="button"
          className="filter-chip-remove"
          aria-label={t('insights.removeFilter', { name: t('insights.requestId') })}
          onClick={() => onChange({ ...value, requestId: '' })}
        >
          <X size={12} />
        </button>
      )}
    </form>
  );
}
