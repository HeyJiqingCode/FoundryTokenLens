import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { getLocale, t, useLocale } from '../../i18n';
import { intervalMs } from '../../../shared/time-window';
import { callCount, weekdayName } from './format';

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  values: number[];
}
interface ChartLine {
  key: string;
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

/** Round axis maximum so the four grid steps land on readable values. */
function niceScale(peak: number) {
  if (!(peak > 0)) return { max: 1, ticks: [0] };
  const raw = peak / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw * 0.999)!;
  const max = step * Math.ceil(peak / step - 1e-9);
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

/** Pixels, or 'fill' to take the height left in a flex column (see `.chart.fill`). */
type ChartHeight = number | 'fill';
/** Measured chart container; spread `box` onto its element. */
function useChartBox(requested: ChartHeight) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () =>
      setSize((current) =>
        current.width === element.clientWidth && current.height === element.clientHeight
          ? current
          : { width: element.clientWidth, height: element.clientHeight },
      );
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fill = requested === 'fill';
  return {
    width: size.width,
    height: fill ? size.height : requested,
    box: {
      ref,
      className: fill ? 'chart fill' : 'chart',
      style: fill ? undefined : { height: requested },
    },
  };
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function zonedParts(iso: string, timeZone: string) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    partsFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  return {
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}
const two = (value: number) => String(value).padStart(2, '0');

function timeTicks(buckets: string[], interval: string, timeZone: string, plotWidth: number) {
  if (!buckets.length) return [];
  const parts = buckets.map((bucket) => zonedParts(bucket, timeZone));
  const daily = interval.endsWith('d');
  const multiDay = parts.some((p) => p.day !== parts[0].day || p.month !== parts[0].month);
  let candidates = parts.map((_, i) => i);
  let label = (i: number) => `${parts[i].month}/${parts[i].day}`;
  if (!daily && multiDay) {
    candidates = candidates.filter((i) =>
      i === 0 ? parts[0].hour === 0 && parts[0].minute === 0 : parts[i].day !== parts[i - 1].day,
    );
  } else if (!daily) {
    const hours = candidates.filter((i) => parts[i].minute === 0);
    if (hours.length) candidates = hours;
    label = (i) => `${two(parts[i].hour)}:${two(parts[i].minute)}`;
  }
  const step = Math.max(1, Math.ceil(candidates.length / Math.max(2, Math.floor(plotWidth / 64))));
  return candidates
    .filter((_, k) => k % step === 0)
    .map((index) => ({ index, label: label(index), boundary: !daily && multiDay }));
}

function bucketLabel(bucket: string, interval: string, timeZone: string) {
  const locale = getLocale();
  const start = new Date(bucket);
  const daily = interval.endsWith('d');
  const end = new Date(start.getTime() + (intervalMs(interval) || 3600000));
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(daily ? {} : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  });
  if (daily) return date.format(start);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return `${date.format(start)} – ${time.format(end)}`;
}

function axisWidth(labels: string[]) {
  return Math.max(36, Math.max(...labels.map((label) => label.length)) * 6.6 + 14);
}

type Frame = { width: number; height: number; left: number; top: number; bottom: number };
const RIGHT = 8;
function TimeAxes({
  frame,
  ticks,
  format,
  y,
  buckets,
  interval,
  timeZone,
  band,
}: {
  frame: Frame;
  ticks: number[];
  format: (value: number) => string;
  y: (value: number) => number;
  buckets: string[];
  interval: string;
  timeZone: string;
  band: number;
}) {
  const plot = frame.width - frame.left - RIGHT;
  return (
    <>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={frame.left}
            x2={frame.width - RIGHT}
            y1={y(tick)}
            y2={y(tick)}
            className={tick ? 'chart-grid' : 'chart-baseline'}
          />
          <text x={frame.left - 8} y={y(tick) + 4} textAnchor="end">
            {format(tick)}
          </text>
        </g>
      ))}
      {timeTicks(buckets, interval, timeZone, plot).map((tick) => (
        <g key={tick.index}>
          {tick.boundary && (
            <line
              x1={frame.left + tick.index * band}
              x2={frame.left + tick.index * band}
              y1={frame.top}
              y2={frame.height - frame.bottom}
              className="chart-grid"
            />
          )}
          <text
            x={frame.left + (tick.boundary ? tick.index * band + 3 : (tick.index + 0.5) * band)}
            y={frame.height - 7}
            textAnchor={tick.boundary ? 'start' : 'middle'}
          >
            {tick.label}
          </text>
        </g>
      ))}
    </>
  );
}

function Tooltip({
  x,
  width,
  title,
  children,
}: {
  x: number;
  width: number;
  title: string;
  children: ReactNode;
}) {
  const flip = x > width / 2;
  return (
    <div
      className="chart-tooltip"
      style={{ left: flip ? x - 12 : x + 12, transform: flip ? 'translateX(-100%)' : undefined }}
    >
      <div className="chart-tooltip-title">{title}</div>
      {children}
    </div>
  );
}
function TooltipRow({
  color,
  name,
  value,
  strong,
}: {
  color?: string;
  name: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className={`chart-tooltip-row${strong ? ' total' : ''}`}>
      <span>
        {color && <i className="legend-swatch" style={{ background: color }} />}
        {name}
      </span>
      <span>{value}</span>
    </div>
  );
}

function hoverIndex(event: MouseEvent<SVGSVGElement>, left: number, band: number, count: number) {
  const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
  const index = Math.floor((x - left) / band);
  return index >= 0 && index < count ? index : null;
}

/** Stacked columns for additive metrics; buckets without calls are drawn as 0. */
export function TimeBarChart({
  buckets,
  series,
  format,
  interval,
  timeZone,
  label,
  height: requested = 240,
}: {
  buckets: string[];
  series: ChartSeries[];
  format: (value: number) => string;
  interval: string;
  timeZone: string;
  label: string;
  height?: ChartHeight;
}) {
  useLocale();
  const { width, height, box } = useChartBox(requested);
  const [hovered, setHover] = useState<number | null>(null);
  // A refresh may shorten the buckets under a resting pointer.
  const hover = hovered !== null && hovered < buckets.length ? hovered : null;
  const totals = buckets.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const peak = Math.max(0, ...totals);
  const { max, ticks } = niceScale(peak);
  const frame = { width, height, left: axisWidth(ticks.map(format)), top: 8, bottom: 24 };
  const band = buckets.length ? (width - frame.left - RIGHT) / buckets.length : 0;
  const y = (value: number) => frame.top + (height - frame.top - frame.bottom) * (1 - value / max);
  const gap = band > 4 ? band * 0.16 : 0;
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={(event) => setHover(hoverIndex(event, frame.left, band, buckets.length))}
          onMouseLeave={() => setHover(null)}
        >
          <TimeAxes
            frame={frame}
            ticks={ticks}
            format={format}
            y={y}
            buckets={buckets}
            interval={interval}
            timeZone={timeZone}
            band={band}
          />
          {hover !== null && (
            <rect
              className="chart-hover"
              x={frame.left + hover * band}
              y={frame.top}
              width={band}
              height={height - frame.top - frame.bottom}
            />
          )}
          {buckets.map((bucket, i) => {
            let stacked = 0;
            return (
              <g key={bucket}>
                {series.map((s) => {
                  const value = s.values[i] ?? 0;
                  if (!value) return null;
                  const top = y(stacked + value);
                  const bottom = y(stacked);
                  stacked += value;
                  return (
                    <rect
                      key={s.key}
                      x={frame.left + i * band + gap / 2}
                      y={top}
                      width={Math.max(1, band - gap)}
                      height={Math.max(0.75, bottom - top)}
                      style={{ fill: s.color }}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {!peak && <div className="chart-empty-note">{t('insights.noChartData')}</div>}
      {hover !== null && (
        <Tooltip
          x={frame.left + (hover + 0.5) * band}
          width={width}
          title={bucketLabel(buckets[hover], interval, timeZone)}
        >
          {totals[hover] ? (
            <>
              {series
                .filter((s) => s.values[hover])
                .map((s) => (
                  <TooltipRow
                    key={s.key}
                    color={s.color}
                    name={s.name}
                    value={format(s.values[hover])}
                  />
                ))}
              {series.filter((s) => s.values[hover]).length > 1 && (
                <TooltipRow name={t('insights.total')} value={format(totals[hover])} strong />
              )}
            </>
          ) : (
            <TooltipRow name={t('insights.noCallsInBucket')} value={format(0)} />
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** Lines for ratios and percentiles; empty buckets are skipped and neighbouring points joined. */
export function TimeLineChart({
  buckets,
  lines,
  format,
  interval,
  timeZone,
  label,
  height: requested = 200,
  fixedMax,
}: {
  buckets: string[];
  lines: ChartLine[];
  format: (value: number) => string;
  interval: string;
  timeZone: string;
  label: string;
  height?: ChartHeight;
  fixedMax?: number;
}) {
  useLocale();
  const { width, height, box } = useChartBox(requested);
  const [hovered, setHover] = useState<number | null>(null);
  const hover = hovered !== null && hovered < buckets.length ? hovered : null;
  const values = lines.flatMap((line) => line.values.filter((v): v is number => v !== null));
  const { max, ticks } = niceScale(fixedMax ?? Math.max(0, ...values));
  const frame = { width, height, left: axisWidth(ticks.map(format)), top: 8, bottom: 24 };
  const band = buckets.length ? (width - frame.left - RIGHT) / buckets.length : 0;
  const y = (value: number) => frame.top + (height - frame.top - frame.bottom) * (1 - value / max);
  const x = (i: number) => frame.left + (i + 0.5) * band;
  const dots = values.length <= 90 * Math.max(1, lines.length);
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={(event) => setHover(hoverIndex(event, frame.left, band, buckets.length))}
          onMouseLeave={() => setHover(null)}
        >
          <TimeAxes
            frame={frame}
            ticks={ticks}
            format={format}
            y={y}
            buckets={buckets}
            interval={interval}
            timeZone={timeZone}
            band={band}
          />
          {hover !== null && (
            <line
              className="chart-crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={frame.top}
              y2={height - frame.bottom}
            />
          )}
          {lines.map((line) => {
            const points = line.values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v)]]));
            return (
              <g key={line.key} style={{ color: line.color }}>
                <polyline
                  points={points.map((p) => p.join(',')).join(' ')}
                  className="chart-line"
                  strokeDasharray={line.dashed ? '4 3' : undefined}
                />
                {(dots || points.length === 1) &&
                  points.map(([cx, cy]) => (
                    <circle key={cx} cx={cx} cy={cy} r={2.2} className="chart-dot" />
                  ))}
              </g>
            );
          })}
        </svg>
      )}
      {!values.length && <div className="chart-empty-note">{t('insights.noChartData')}</div>}
      {hover !== null && (
        <Tooltip x={x(hover)} width={width} title={bucketLabel(buckets[hover], interval, timeZone)}>
          {lines.map((line) => (
            <TooltipRow
              key={line.key}
              color={line.color}
              name={line.name}
              value={
                line.values[hover] === null ? t('insights.noCalls') : format(line.values[hover]!)
              }
            />
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export function ChartLegend({
  items,
}: {
  items: { key: string; name: string; color: string; value?: string; dashed?: boolean }[];
}) {
  return (
    <ul className="chart-legend">
      {items.map((item) => (
        <li key={item.key}>
          <i
            className={`legend-swatch${item.dashed ? ' dashed' : ''}`}
            style={{ background: item.color }}
          />
          {item.name}
          {item.value !== undefined && <b>{item.value}</b>}
        </li>
      ))}
    </ul>
  );
}

/** Calls per bin, with the count above each bar. */
export function Histogram({
  bins,
  color,
  label,
}: {
  bins: { name: string; count: number }[];
  color: string;
  label: string;
}) {
  useLocale();
  const peak = Math.max(1, ...bins.map((bin) => bin.count));
  return (
    <div className="histogram" role="img" aria-label={label}>
      {bins.map((bin) => (
        <div key={bin.name} className="histogram-column">
          <b>{callCount(bin.count)}</b>
          <i style={{ height: `${(bin.count / peak) * 78}%`, background: color }} />
          <span>{bin.name}</span>
        </div>
      ))}
    </div>
  );
}

export function WeekHourHeatmap({
  cells,
  describe,
}: {
  cells: { day: number; hour: number; requests: number }[];
  describe: (day: string, hour: number, requests: number) => string;
}) {
  const locale = useLocale();
  const peak = Math.max(1, ...cells.map((cell) => cell.requests));
  const lookup = new Map(cells.map((cell) => [`${cell.day}/${cell.hour}`, cell.requests]));
  const days = Array.from({ length: 7 }, (_, day) => weekdayName(day, locale));
  return (
    <div className="heatmap">
      <div className="heatmap-grid">
        {days.map((name, day) => (
          <div className="heatmap-row" key={name}>
            <span>{name}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const requests = lookup.get(`${day}/${hour}`) ?? 0;
              return (
                <i
                  key={hour}
                  title={describe(name, hour, requests)}
                  style={{
                    background: requests
                      ? `color-mix(in srgb, var(--blue) ${14 + (requests / peak) * 86}%, var(--surface-muted))`
                      : undefined,
                  }}
                />
              );
            })}
          </div>
        ))}
        <div className="heatmap-row heatmap-axis" aria-hidden="true">
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <span key={hour}>{hour % 3 === 0 ? two(hour) : ''}</span>
          ))}
        </div>
      </div>
      <div className="heatmap-legend">
        {t('insights.fewer')}
        <span className="heatmap-scale" />
        {t('insights.more')} · {t('insights.peakPerHour', { count: peak })}
      </div>
    </div>
  );
}

export function ScatterPlot({
  points,
  xFormat,
  yFormat,
  xLabel,
  label,
  height: requested = 250,
}: {
  points: { key: string; x: number; y: number; color: string; title: string }[];
  xFormat: (value: number) => string;
  yFormat: (value: number) => string;
  xLabel: string;
  label: string;
  height?: ChartHeight;
}) {
  const { width, height, box } = useChartBox(requested);
  const xs = niceScale(Math.max(0, ...points.map((p) => p.x)));
  const ys = niceScale(Math.max(0, ...points.map((p) => p.y)));
  const left = axisWidth(ys.ticks.map(yFormat));
  const top = 8,
    bottom = 38;
  const x = (value: number) => left + (width - left - RIGHT - 12) * (value / xs.max);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / ys.max);
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg width={width} height={height} role="img" aria-label={label}>
          {ys.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                className={tick ? 'chart-grid' : 'chart-baseline'}
              />
              <text x={left - 8} y={y(tick) + 4} textAnchor="end">
                {yFormat(tick)}
              </text>
            </g>
          ))}
          {xs.ticks.map((tick) => (
            <text key={tick} x={x(tick)} y={height - 20} textAnchor="middle">
              {xFormat(tick)}
            </text>
          ))}
          <text x={(left + width) / 2} y={height - 4} textAnchor="middle">
            {xLabel}
          </text>
          {points.map((point) => (
            <circle
              key={point.key}
              cx={x(point.x)}
              cy={y(point.y)}
              r={3}
              className="chart-point"
              style={{ fill: point.color }}
            >
              <title>{point.title}</title>
            </circle>
          ))}
        </svg>
      )}
      {!points.length && <div className="chart-empty-note">{t('insights.noChartData')}</div>}
    </div>
  );
}
