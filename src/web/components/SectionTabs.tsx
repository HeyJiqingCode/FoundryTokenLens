import { LocalizedLabel } from './LocalizedLabel';
import type { MessageKey } from '../i18n';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router';

export function SectionTabs<T extends string>({
  id,
  label,
  value,
  items,
  hrefFor,
}: {
  id: string;
  label: string;
  value: T;
  items: readonly { id: T; label: MessageKey }[];
  hrefFor: (value: T) => string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === ' ' && document.activeElement?.getAttribute('role') === 'tab') {
      event.preventDefault();
      (document.activeElement as HTMLAnchorElement).click();
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>('[role="tab"]'),
    );
    const current = tabs.indexOf(document.activeElement as HTMLAnchorElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  }
  return (
    <div
      ref={rootRef}
      className="section-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={moveFocus}
    >
      {items.map((item) => (
        <Link
          key={item.id}
          className="section-tab"
          id={`${id}-tab-${item.id}`}
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`${id}-content`}
          tabIndex={value === item.id ? 0 : -1}
          to={hrefFor(item.id)}
          onFocus={(event) =>
            event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
          }
        >
          <LocalizedLabel message={item.label} />
        </Link>
      ))}
    </div>
  );
}
