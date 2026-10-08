import { useEffect, useLayoutEffect, useRef } from 'react';
import { ScrollViewport } from '../ScrollViewport';

const ROW_HEIGHT = 32;
export function TimeWheel({
  label,
  count,
  step = 1,
  value,
  onChange,
}: {
  label: string;
  count: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrolling = useRef(false);
  const userScroll = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useLayoutEffect(() => {
    const scroll = root.current!.querySelector<HTMLElement>('.scroll-body')!;
    if (!scrolling.current) scroll.scrollTop = (value / step) * ROW_HEIGHT;
  }, [value, step]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div
      className="time-wheel"
      ref={root}
      onWheelCapture={() => {
        userScroll.current = true;
      }}
      onPointerDownCapture={() => {
        userScroll.current = true;
      }}
      onKeyDownCapture={(event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
          userScroll.current = true;
      }}
      onScrollCapture={(event) => {
        const scroll = event.target as HTMLElement;
        if (!userScroll.current || !scroll.classList.contains('scroll-body')) return;
        scrolling.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const next = Math.max(0, Math.min(count - 1, Math.round(scroll.scrollTop / ROW_HEIGHT)));
          const top = next * ROW_HEIGHT;
          if (Math.abs(scroll.scrollTop - top) > 1) {
            scroll.scrollTop = top;
          }
          if (next * step !== latest.current.value) latest.current.onChange(next * step);
          scrolling.current = false;
          userScroll.current = false;
        }, 180);
      }}
    >
      <span className="time-wheel-label">{label}</span>
      <div className="time-wheel-window">
        <ScrollViewport className="time-wheel-viewport" label={label}>
          {Array.from({ length: count }, (_, n) => (
            <button
              key={n}
              type="button"
              className="time-wheel-value"
              aria-pressed={n * step === value}
              onClick={() => {
                clearTimeout(timer.current);
                scrolling.current = false;
                userScroll.current = false;
                root.current!.querySelector<HTMLElement>('.scroll-body')!.scrollTop =
                  n * ROW_HEIGHT;
                onChange(n * step);
              }}
            >
              {String(n * step).padStart(2, '0')}
            </button>
          ))}
        </ScrollViewport>
      </div>
    </div>
  );
}
