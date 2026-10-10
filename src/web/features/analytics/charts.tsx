import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getLocale, t, useLocale } from '../../i18n';
import type { Interval } from '../../../shared/analytics';
import { intervalMs, nextBucket } from '../../../shared/time-window';
import { callCount, count, hourLabel, share, shortCallCount, weekdayName } from './format';

export interface ChartSeries {
  key: string;
  name: string;
  color: string;
  values: number[];
  /** What each value is made of, such as a resource's models, listed under it on hover. */
  parts?: ChartPart[];
}
export interface ChartPart {
  key: string;
  name: string;
  color: string;
  values: number[];
}
/** A part's value at one bucket, bin or band. */
type PartValue = Omit<ChartPart, 'values'> & { value: number };
interface ChartLine {
  key: string;
  name: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

/**
 * Round axis maximum so the four grid steps land on readable values; `whole` keeps the steps to
 * whole numbers, for counts.
 */
function niceScale(peak: number, whole = false) {
  if (!(peak > 0)) return { max: 1, ticks: [0] };
  const raw = peak / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const nice = (whole ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10])
    .map((m) => m * power)
    .find((s) => s >= raw * 0.999)!;
  const step = whole ? Math.max(1, nice) : nice;
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

let measure: CanvasRenderingContext2D | null | undefined;
/** Width of `text` at 11px in the page font, with `weight` as the chart labels use it. */
function textWidth(text: string, weight = 400) {
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return text.length * 6.6;
  measure.font = `${weight} 11px ${getComputedStyle(document.body).fontFamily}`;
  return measure.measureText(text).width;
}
/** An axis label: the value with its unit, except a bare 0 where the axes meet. */
const tickLabel = (tick: number, format: (value: number) => string) => (tick ? format(tick) : '0');
/**
 * Width of the value axis: its widest label plus the gap before the plot. The labels start at
 * the chart's left edge, in line with the legend above.
 */
function axisWidth(labels: string[]) {
  return Math.ceil(Math.max(0, ...labels.map((label) => textWidth(label)))) + 10;
}

type Frame = { width: number; height: number; left: number; top: number; bottom: number };
const RIGHT = 8;
/**
 * The plot of a time chart `width` × `height` with `count` buckets: a value axis up to `peak`
 * whose labels set its left edge, each bucket's band, and where a value and a bucket's middle fall.
 */
function timePlot(
  width: number,
  height: number,
  peak: number,
  count: number,
  format: (value: number) => string,
  whole = false,
) {
  const { max, ticks } = niceScale(peak, whole);
  const frame = {
    width,
    height,
    left: axisWidth(ticks.map((tick) => tickLabel(tick, format))),
    top: 8,
    bottom: 24,
  };
  const band = count ? (width - frame.left - RIGHT) / count : 0;
  return {
    ticks,
    frame,
    band,
    y: (value: number) => frame.top + (height - frame.top - frame.bottom) * (1 - value / max),
    x: (i: number) => frame.left + (i + 0.5) * band,
  };
}
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
          <text x={0} y={y(tick) + 4}>
            {tickLabel(tick, format)}
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

/** Closest a tooltip comes to the window's edges. */
const EDGE = 8;
/**
 * The hover box of a chart, beside `x` across its container and flipped to the left past the
 * middle. It is drawn above the whole page, so no card or scrolling list cuts a long one off,
 * and kept inside the window: moved up when it would run past the bottom.
 */
function Tooltip({ x, title, children }: { x: number; title: ReactNode; children: ReactNode }) {
  const marker = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Every render: the rows, and so the size, change as the pointer moves.
  useLayoutEffect(() => {
    const container = marker.current?.parentElement,
      tip = box.current;
    if (!container || !tip) return;
    const update = () => {
      const area = container.getBoundingClientRect();
      const beside = area.left + x + (x > area.width / 2 ? -12 - tip.offsetWidth : 12);
      const left = Math.max(EDGE, Math.min(beside, window.innerWidth - EDGE - tip.offsetWidth));
      const top = Math.max(
        EDGE,
        Math.min(area.top + 4, window.innerHeight - EDGE - tip.offsetHeight),
      );
      setPlace((current) =>
        current?.left === left && current.top === top ? current : { left, top },
      );
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  });
  return (
    <>
      <span ref={marker} hidden />
      {createPortal(
        <div
          ref={box}
          className="chart-tooltip"
          style={place ?? { left: 0, top: 0, visibility: 'hidden' }}
        >
          <div className="chart-tooltip-title">{title}</div>
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}
function TooltipRow({
  color,
  name,
  value,
  strong,
  part,
}: {
  color?: string;
  name: string;
  value: string;
  strong?: boolean;
  /** Indented under the row it is part of. */
  part?: boolean;
}) {
  return (
    <div className={`chart-tooltip-row${strong ? ' total' : ''}${part ? ' part' : ''}`}>
      <span>
        {color && <i className="legend-swatch" style={{ background: color }} />}
        {name}
      </span>
      <span>{value}</span>
    </div>
  );
}

/** The parts of a tooltip row that have a value, largest first, indented under it. */
function PartRows({
  parts = [],
  format,
}: {
  parts?: PartValue[];
  format: (value: number) => string;
}) {
  return parts
    .filter((part) => part.value)
    .sort((a, b) => b.value - a.value)
    .map((part) => (
      <TooltipRow
        key={part.key}
        color={part.color}
        name={part.name}
        value={format(part.value)}
        part
      />
    ));
}
/** A series' parts at index `i`. */
const partsAt = (series: ChartSeries, i: number) =>
  series.parts?.map((part) => ({ ...part, value: part.values[i] ?? 0 }));

/**
 * Where the tooltip for a hovered `element` sits across `container`: `at` of the way across the
 * element, its middle by default.
 */
function anchor(element: Element, container: Element, at = 0.5) {
  const box = element.getBoundingClientRect();
  return { x: box.left - container.getBoundingClientRect().left + box.width * at };
}

function hoverIndex(event: MouseEvent<SVGSVGElement>, left: number, band: number, count: number) {
  const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
  const index = Math.floor((x - left) / band);
  return index >= 0 && index < count ? index : null;
}

/**
 * Applies a span of time dragged across a chart as the report's time range. The time bar and line
 * charts take it; the month forecast, whose days are not the report's, does not.
 */
export const TimeRangeSelect = createContext<((from: string, to: string) => void) | null>(null);

/**
 * Dragging across a time chart highlights the buckets from where the pointer went down to where
 * it is, and on release selects them, from the first one's start to the last one's end, as the
 * time range. A drag that stays in one bucket, or moves a few pixels, is a click.
 */
function useBrush(
  buckets: string[],
  interval: string,
  timeZone: string,
  left: number,
  band: number,
) {
  const select = useContext(TimeRangeSelect);
  const origin = useRef<{ x: number; at: number; svg: SVGSVGElement } | null>(null);
  const [span, setSpan] = useState<[number, number] | null>(null);
  const dragging = span !== null;
  useEffect(() => {
    const from = origin.current;
    if (!dragging || !from) return;
    const at = (clientX: number) =>
      Math.min(
        buckets.length - 1,
        Math.max(0, Math.floor((clientX - from.svg.getBoundingClientRect().left - left) / band)),
      );
    const move = (event: globalThis.MouseEvent) => {
      const end = at(event.clientX);
      setSpan((span) => (span?.[1] === end ? span : [from.at, end]));
    };
    const up = (event: globalThis.MouseEvent) => {
      const end = at(event.clientX);
      origin.current = null;
      setSpan(null);
      if (!select || end === from.at || Math.abs(event.clientX - from.x) < 6) return;
      const last = Math.max(from.at, end);
      select(
        buckets[Math.min(from.at, end)],
        nextBucket(buckets[last], interval as Exclude<Interval, 'auto'>, timeZone),
      );
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, buckets, band, left, interval, timeZone, select]);
  return {
    enabled: Boolean(select),
    span,
    start(event: MouseEvent<SVGSVGElement>) {
      if (!select || event.button !== 0) return;
      const at = hoverIndex(event, left, band, buckets.length);
      if (at === null) return;
      // No text selection while dragging.
      event.preventDefault();
      origin.current = { x: event.clientX, at, svg: event.currentTarget };
      setSpan([at, at]);
    },
  };
}
/** The buckets a drag covers, across the plot's height. */
function BrushArea({
  span,
  frame,
  band,
}: {
  span: [number, number] | null;
  frame: Frame;
  band: number;
}) {
  if (!span) return null;
  return (
    <rect
      className="chart-brush"
      x={frame.left + Math.min(...span) * band}
      y={frame.top}
      width={(Math.abs(span[1] - span[0]) + 1) * band}
      height={frame.height - frame.top - frame.bottom}
    />
  );
}

/** Stacked columns for additive metrics; buckets without calls are drawn as 0. */
export function TimeBarChart({
  buckets,
  series,
  details,
  format,
  interval,
  timeZone,
  label,
  height: requested = 240,
}: {
  buckets: string[];
  series: ChartSeries[];
  /** Listed on hover instead of `series`, to break a single total down. */
  details?: ChartSeries[];
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
  // Stacked series follow the stack; details, with no legend to follow, list the largest first.
  const listed =
    hover === null || !details
      ? series
      : [...details].sort((a, b) => b.values[hover] - a.values[hover]);
  const peak = Math.max(0, ...totals);
  // Counts of calls or tokens step in whole numbers.
  const whole = series.every((s) => s.values.every(Number.isInteger));
  const { ticks, frame, band, y } = timePlot(width, height, peak, buckets.length, format, whole);
  const gap = band > 4 ? band * 0.16 : 0;
  const brush = useBrush(buckets, interval, timeZone, frame.left, band);
  const tip = brush.span ? null : hover;
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className={brush.enabled ? 'brushable' : undefined}
          onMouseDown={brush.start}
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
          {tip !== null && (
            <rect
              className="chart-hover"
              x={frame.left + tip * band}
              y={frame.top}
              width={band}
              height={height - frame.top - frame.bottom}
            />
          )}
          <BrushArea span={brush.span} frame={frame} band={band} />
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
      {tip !== null && (
        <Tooltip
          x={frame.left + (tip + 0.5) * band}
          title={bucketLabel(buckets[tip], interval, timeZone)}
        >
          {totals[tip] ? (
            <>
              {listed
                .filter((s) => s.values[tip])
                .map((s) => (
                  <Fragment key={s.key}>
                    <TooltipRow color={s.color} name={s.name} value={format(s.values[tip])} />
                    <PartRows parts={partsAt(s, tip)} format={format} />
                  </Fragment>
                ))}
              {listed.filter((s) => s.values[tip]).length > 1 && (
                <TooltipRow name={t('insights.total')} value={format(totals[tip])} strong />
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
  const { ticks, frame, band, y, x } = timePlot(
    width,
    height,
    fixedMax ?? Math.max(0, ...values),
    buckets.length,
    format,
  );
  const dots = values.length <= 90 * Math.max(1, lines.length);
  const brush = useBrush(buckets, interval, timeZone, frame.left, band);
  const tip = brush.span ? null : hover;
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          className={brush.enabled ? 'brushable' : undefined}
          onMouseDown={brush.start}
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
          <BrushArea span={brush.span} frame={frame} band={band} />
          {tip !== null && (
            <line
              className="chart-crosshair"
              x1={x(tip)}
              x2={x(tip)}
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
      {tip !== null && (
        <Tooltip x={x(tip)} title={bucketLabel(buckets[tip], interval, timeZone)}>
          {lines.map((line) => (
            <TooltipRow
              key={line.key}
              color={line.color}
              name={line.name}
              value={line.values[tip] === null ? t('insights.noCalls') : format(line.values[tip]!)}
            />
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A month's cost building up day by day: `areas` drawn in order, each over the days it has a
 * value for (the days so far, then the forecast from today), with a dashed `reference` total
 * across. Hovering a day lists the areas with a value that day, then the reference.
 */
export function CumulativeChart({
  days,
  areas,
  reference,
  format,
  timeZone,
  label,
  height: requested = 'fill',
}: {
  days: string[];
  areas: ChartLine[];
  reference?: { name: string; color: string; value: number };
  format: (value: number) => string;
  timeZone: string;
  label: string;
  height?: ChartHeight;
}) {
  useLocale();
  const { width, height, box } = useChartBox(requested);
  const [hovered, setHover] = useState<number | null>(null);
  const hover = hovered !== null && hovered < days.length ? hovered : null;
  const values = areas.flatMap((area) => area.values.filter((v): v is number => v !== null));
  const { ticks, frame, band, y, x } = timePlot(
    width,
    height,
    Math.max(0, ...values, reference?.value ?? 0),
    days.length,
    format,
  );
  const shown = (area: ChartLine, i: number) =>
    area.values[i] !== null &&
    !areas.some((other, k) => k < areas.indexOf(area) && other.values[i] !== null);
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={(event) => setHover(hoverIndex(event, frame.left, band, days.length))}
          onMouseLeave={() => setHover(null)}
        >
          <TimeAxes
            frame={frame}
            ticks={ticks}
            format={format}
            y={y}
            buckets={days}
            interval="1d"
            timeZone={timeZone}
            band={band}
          />
          {areas.map((area) => {
            const points = area.values.flatMap((v, i) => (v === null ? [] : [[x(i), y(v)]]));
            if (!points.length) return null;
            const base = y(0);
            const path = `M${points[0][0]},${base} ${points.map(([px, py]) => `L${px},${py}`).join(' ')} L${points.at(-1)![0]},${base}Z`;
            return (
              <path key={area.key} d={path} className="chart-area" style={{ fill: area.color }} />
            );
          })}
          {reference && (
            <line
              className="chart-reference"
              x1={frame.left}
              x2={width - RIGHT}
              y1={y(reference.value)}
              y2={y(reference.value)}
              style={{ stroke: reference.color }}
            />
          )}
          {hover !== null && (
            <line
              className="chart-crosshair"
              x1={x(hover)}
              x2={x(hover)}
              y1={frame.top}
              y2={height - frame.bottom}
            />
          )}
        </svg>
      )}
      {!values.some(Boolean) && !reference && (
        <div className="chart-empty-note">{t('insights.noChartData')}</div>
      )}
      {hover !== null && (
        <Tooltip x={x(hover)} title={bucketLabel(days[hover], '1d', timeZone)}>
          {areas
            .filter((area) => shown(area, hover))
            .map((area) => (
              <TooltipRow
                key={area.key}
                color={area.color}
                name={area.name}
                value={format(area.values[hover]!)}
              />
            ))}
          {reference && (
            <TooltipRow
              color={reference.color}
              name={reference.name}
              value={format(reference.value)}
            />
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** Swatches with names above a chart; `compact` sets them small, as under the drawer's time bar. */
export function ChartLegend({
  items,
  compact = false,
}: {
  items: { key: string; name: string; color: string; dashed?: boolean }[];
  compact?: boolean;
}) {
  return (
    <ul className={`chart-legend${compact ? ' compact' : ''}`}>
      {items.map((item) => (
        <li key={item.key}>
          <i
            className={`legend-swatch${item.dashed ? ' dashed' : ''}`}
            style={{ background: item.color }}
          />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

/**
 * Calls per bin, stacked by `series` with the first at the bottom, filling the card. Each bin's
 * lower bound from `edges` sits on the boundary before it; the counts above drop their unit when
 * neighbours would touch. Hovering a bin shows it in full, like the time charts.
 */
export function Histogram({
  bins,
  series,
  label,
  edges,
  edgeUnit,
}: {
  bins: { name: string; count: number }[];
  series: ChartSeries[];
  label: string;
  edges: string[];
  /** Follows the last edge without moving it off its boundary. */
  edgeUnit?: string;
}) {
  useLocale();
  const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const peak = Math.max(1, ...bins.map((bin) => bin.count));
  const parts = hover ? series.filter((item) => item.values[hover.i]) : [];
  // Columns sit 6px apart, so neighbouring labels are (width + 6) / columns apart.
  let labels = bins.map((bin) => shortCallCount(bin.count));
  const spacing = bins.length ? (width + 6) / bins.length : 0;
  if (
    labels.some(
      (text, i) => i && (textWidth(labels[i - 1], 550) + textWidth(text, 550)) / 2 + 2 > spacing,
    )
  )
    labels = bins.map((bin) => count(bin.count));
  return (
    <div
      ref={ref}
      className="histogram"
      role="img"
      aria-label={label}
      onMouseLeave={() => setHover(null)}
    >
      {bins.map((bin, i) => {
        const height = `${(bin.count / peak) * 78}%`;
        return (
          <div
            key={bin.name}
            className={`histogram-column${hover?.i === i ? ' hovered' : ''}`}
            onMouseEnter={(event) =>
              setHover({ i, ...anchor(event.currentTarget, event.currentTarget.parentElement!) })
            }
          >
            <b>{labels[i]}</b>
            <span className="histogram-stack" style={{ height }}>
              {series.map((item) =>
                item.values[i] ? (
                  <i key={item.key} style={{ flexGrow: item.values[i], background: item.color }} />
                ) : null,
              )}
            </span>
            <span className="histogram-edge">
              {edges[i]}
              {edgeUnit && i === bins.length - 1 && (
                <span className="histogram-edge-unit">{edgeUnit}</span>
              )}
            </span>
          </div>
        );
      })}
      {hover && (
        <Tooltip x={hover.x} title={bins[hover.i].name}>
          {parts.map((item) => (
            <Fragment key={item.key}>
              <TooltipRow
                color={item.color}
                name={item.name}
                value={callCount(item.values[hover.i])}
              />
              <PartRows parts={partsAt(item, hover.i)} format={callCount} />
            </Fragment>
          ))}
          {parts.length !== 1 && (
            <TooltipRow
              name={t('insights.total')}
              value={callCount(bins[hover.i].count)}
              strong={parts.length > 1}
            />
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** One group's part of a band in `BandBars`. */
interface BandSlice {
  key: string;
  name: string;
  color: string;
  value: number;
  parts?: PartValue[];
}
/**
 * One row per band, such as a context price band or a token type: its name, `detail` and share
 * of the total above a bar as long as that share, stacked by group. Hovering a row lists its
 * groups like the other charts; `onSelect` makes the names clickable.
 */
export function BandBars({
  bands,
  label,
  format,
  onSelect,
}: {
  bands: { key: string; name: string; detail: string; slices: BandSlice[] }[];
  label: string;
  /** How a group's value reads in the tooltip. */
  format: (value: number) => string;
  onSelect?: (band: string) => void;
}) {
  useLocale();
  const [hover, setHover] = useState<{ band: number; x: number } | null>(null);
  const sum = (slices: BandSlice[]) => slices.reduce((part, slice) => part + slice.value, 0);
  const total = bands.reduce((part, band) => part + sum(band.slices), 0);
  const hovered = hover === null ? null : bands[hover.band];
  const parts = hovered ? hovered.slices.filter((slice) => slice.value) : [];
  return (
    <div
      className="band-bars"
      role={onSelect ? 'group' : 'img'}
      aria-label={label}
      onMouseLeave={() => setHover(null)}
    >
      {bands.map((band, b) => {
        const value = sum(band.slices);
        return (
          <div
            key={band.key}
            className={`band-bar${hover?.band === b ? ' hovered' : ''}`}
            onMouseEnter={(event) =>
              // At the end of the band's bar, so the tooltip opens beside what it describes.
              setHover({
                band: b,
                ...anchor(
                  event.currentTarget,
                  event.currentTarget.parentElement!,
                  Math.max(0.1, total ? value / total : 0),
                ),
              })
            }
          >
            <div className="band-bar-head">
              {onSelect ? (
                <button type="button" className="entity-name" onClick={() => onSelect(band.key)}>
                  <span className="link-name">{band.name}</span>
                </button>
              ) : (
                <span>{band.name}</span>
              )}
              <small>{band.detail}</small>
              <b>{share(value, total)}</b>
            </div>
            <span className="band-bar-track" aria-hidden="true">
              <span
                className="band-bar-fill"
                style={{ width: `${total ? (value / total) * 100 : 0}%` }}
              >
                {band.slices.map((slice) =>
                  slice.value ? (
                    <i key={slice.key} style={{ flexGrow: slice.value, background: slice.color }} />
                  ) : null,
                )}
              </span>
            </span>
          </div>
        );
      })}
      {!total && <p className="card-empty">{t('insights.noChartData')}</p>}
      {hover && hovered && (
        <Tooltip x={hover.x} title={`${hovered.name} · ${share(sum(hovered.slices), total)}`}>
          {parts.map((slice) => (
            <Fragment key={slice.key}>
              <TooltipRow color={slice.color} name={slice.name} value={format(slice.value)} />
              <PartRows parts={slice.parts} format={format} />
            </Fragment>
          ))}
          {parts.length !== 1 && (
            <TooltipRow
              name={t('insights.total')}
              value={format(sum(hovered.slices))}
              strong={parts.length > 1}
            />
          )}
        </Tooltip>
      )}
    </div>
  );
}

/** Calls per weekday and hour; hovering a cell shows its hour and calls, like the time charts. */
export function WeekHourHeatmap({
  cells,
}: {
  cells: { day: number; hour: number; requests: number }[];
}) {
  const locale = useLocale();
  const [hover, setHover] = useState<{
    day: number;
    hour: number;
    x: number;
  } | null>(null);
  const peak = Math.max(1, ...cells.map((cell) => cell.requests));
  const lookup = new Map(cells.map((cell) => [`${cell.day}/${cell.hour}`, cell.requests]));
  const days = Array.from({ length: 7 }, (_, day) => weekdayName(day, locale));
  return (
    <div className="heatmap" onMouseLeave={() => setHover(null)}>
      <div className="heatmap-grid">
        {days.map((name, day) => (
          <div className="heatmap-row" key={name}>
            <span>{name}</span>
            {Array.from({ length: 24 }, (_, hour) => {
              const requests = lookup.get(`${day}/${hour}`) ?? 0;
              return (
                <i
                  key={hour}
                  className={hover?.day === day && hover.hour === hour ? 'hovered' : undefined}
                  onMouseEnter={(event) =>
                    setHover({
                      day,
                      hour,
                      ...anchor(event.currentTarget, event.currentTarget.closest('.heatmap')!),
                    })
                  }
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
      {hover && (
        <Tooltip
          x={hover.x}
          title={`${days[hover.day]} ${hourLabel(hover.hour)} – ${hourLabel((hover.hour + 1) % 24)}`}
        >
          <TooltipRow
            color="var(--blue)"
            name={t('insights.calls')}
            value={callCount(lookup.get(`${hover.day}/${hover.hour}`) ?? 0)}
          />
        </Tooltip>
      )}
    </div>
  );
}

/** Points of named series; hovering one shows its series and both values, like the time charts. */
export function ScatterPlot({
  points,
  xFormat,
  yFormat,
  xLabel,
  yLabel,
  label,
  height: requested = 250,
}: {
  points: { key: string; x: number; y: number; color: string; name: string }[];
  xFormat: (value: number) => string;
  yFormat: (value: number) => string;
  xLabel: string;
  yLabel: string;
  label: string;
  height?: ChartHeight;
}) {
  useLocale();
  const { width, height, box } = useChartBox(requested);
  const [hovered, setHover] = useState<number | null>(null);
  const hover = hovered !== null && hovered < points.length ? points[hovered] : null;
  const xs = niceScale(Math.max(0, ...points.map((p) => p.x)));
  const ys = niceScale(Math.max(0, ...points.map((p) => p.y)));
  const left = axisWidth(ys.ticks.map((tick) => tickLabel(tick, yFormat)));
  const top = 8,
    bottom = 38;
  const x = (value: number) => left + (width - left - RIGHT - 12) * (value / xs.max);
  const y = (value: number) => top + (height - top - bottom) * (1 - value / ys.max);
  return (
    <div {...box}>
      {width > 0 && height > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={label}
          onMouseMove={(event) => {
            // The nearest point within 8px of the pointer.
            const box = event.currentTarget.getBoundingClientRect();
            const mx = event.clientX - box.left,
              my = event.clientY - box.top;
            let nearest = null as number | null,
              best = 64;
            points.forEach((point, i) => {
              const distance = (x(point.x) - mx) ** 2 + (y(point.y) - my) ** 2;
              if (distance < best) [nearest, best] = [i, distance];
            });
            setHover(nearest);
          }}
          onMouseLeave={() => setHover(null)}
        >
          {ys.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={width - RIGHT}
                y1={y(tick)}
                y2={y(tick)}
                className={tick ? 'chart-grid' : 'chart-baseline'}
              />
              <text x={0} y={y(tick) + 4}>
                {tickLabel(tick, yFormat)}
              </text>
            </g>
          ))}
          {xs.ticks.map((tick) => (
            <text key={tick} x={x(tick)} y={height - 20} textAnchor="middle">
              {tickLabel(tick, xFormat)}
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
            />
          ))}
          {hover && (
            <circle
              cx={x(hover.x)}
              cy={y(hover.y)}
              r={5}
              className="chart-point active"
              style={{ fill: hover.color }}
            />
          )}
        </svg>
      )}
      {!points.length && <div className="chart-empty-note">{t('insights.noChartData')}</div>}
      {hover && (
        <Tooltip
          x={x(hover.x)}
          title={
            <>
              <i className="legend-swatch" style={{ background: hover.color }} />
              {hover.name}
            </>
          }
        >
          <TooltipRow name={xLabel} value={xFormat(hover.x)} />
          <TooltipRow name={yLabel} value={yFormat(hover.y)} />
        </Tooltip>
      )}
    </div>
  );
}
