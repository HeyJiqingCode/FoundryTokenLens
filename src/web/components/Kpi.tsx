import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { TitleIcon, type Tone } from './Card';

/** One card of figures side by side, optionally titled, with actions at the right of the title. */
export function KpiStrip({
  label,
  icon,
  tone = 'slate',
  actions,
  children,
}: {
  label?: string;
  icon?: LucideIcon;
  tone?: Tone;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card kpi-strip" aria-label={label}>
      {(label || actions) && (
        <header className="card-head kpi-strip-head">
          {label && (
            <h2>
              {icon && <TitleIcon icon={icon} tone={tone} />}
              {label}
            </h2>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="kpi-row">{children}</div>
    </section>
  );
}

/** A figure with its label above and an optional note below. */
export function Kpi({
  label,
  value,
  sub,
  icon,
  tone = 'slate',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
}) {
  return (
    <div className="kpi">
      <div className="kpi-label">
        {icon && <TitleIcon icon={icon} tone={tone} />}
        {label}
      </div>
      <div className={`kpi-value${value === '—' ? ' unavailable' : ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}
