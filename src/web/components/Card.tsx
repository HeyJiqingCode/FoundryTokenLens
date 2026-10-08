import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/** Subject colors (see `.tone-*` in tokens.css) for title icons and chart series. */
export type Tone = 'blue' | 'violet' | 'teal' | 'slate' | 'amber' | 'success' | 'error';

/** Title icon sized to the surrounding text and colored by its subject. */
export function TitleIcon({ icon: Icon, tone }: { icon: LucideIcon; tone: Tone }) {
  return <Icon className={`title-icon tone-${tone}`} aria-hidden="true" />;
}

/** A titled card; `actions` sit at the right of the title row. */
export function Card({
  title,
  icon,
  tone = 'slate',
  actions,
  className = '',
  children,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {(title || actions) && (
        <header className="card-head">
          {title && (
            <h2>
              {icon && <TitleIcon icon={icon} tone={tone} />}
              {title}
            </h2>
          )}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
