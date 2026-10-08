import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function ScrollViewport({
  children,
  label,
  className = '',
  contentClassName = '',
  showScrollbar = true,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
  contentClassName?: string;
  showScrollbar?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const extentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!showScrollbar) return;
    const scroll = scrollRef.current!;
    const content = contentRef.current!;
    const rail = railRef.current!;
    const extent = extentRef.current!;
    // Content and the inset native rail have different scroll ranges.
    // Share progress, leaving browser rounding and elastic overscroll alone.
    function sync(from: HTMLElement, to: HTMLElement) {
      const range = from.scrollHeight - from.clientHeight;
      const progress = range > 0 ? Math.max(0, Math.min(from.scrollTop / range, 1)) : 0;
      const offset = progress * (to.scrollHeight - to.clientHeight);
      if (Math.abs(to.scrollTop - offset) > 1) to.scrollTop = offset;
    }
    const fromContent = () => sync(scroll, rail);
    const fromRail = () => sync(rail, scroll);
    function resize() {
      const viewportHeight = scroll.clientHeight;
      const contentHeight = scroll.scrollHeight;
      rail.hidden = contentHeight <= viewportHeight + 1;
      const extentHeight =
        viewportHeight > 0 ? (contentHeight * rail.clientHeight) / viewportHeight : 0;
      extent.style.height = `${extentHeight}px`;
      fromContent();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener('scroll', fromContent, { passive: true });
    rail.addEventListener('scroll', fromRail, { passive: true });
    resize();
    return () => {
      observer.disconnect();
      scroll.removeEventListener('scroll', fromContent);
      rail.removeEventListener('scroll', fromRail);
    };
  }, [showScrollbar]);

  return (
    <div className={`scroll-viewport ${className}`.trim()}>
      <div
        ref={scrollRef}
        className="scroll-body"
        role={label ? 'region' : undefined}
        aria-label={label}
        tabIndex={label ? 0 : undefined}
      >
        <div ref={contentRef} className={`scroll-content ${contentClassName}`.trim()}>
          {children}
        </div>
      </div>
      {showScrollbar && (
        <div ref={railRef} className="scroll-rail" aria-hidden="true" tabIndex={-1}>
          <div ref={extentRef} />
        </div>
      )}
    </div>
  );
}
