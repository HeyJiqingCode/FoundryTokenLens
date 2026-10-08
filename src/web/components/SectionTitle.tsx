import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { TitleIcon, type Tone } from './Card';

/** A section heading inside a card or dialog, led by an icon in its subject color. */
export function SectionTitle({
  children,
  icon,
  tone = 'blue',
  id,
}: {
  children: ReactNode;
  icon: LucideIcon;
  tone?: Tone;
  id?: string;
}) {
  return (
    <h3 id={id} className="section-title">
      <TitleIcon icon={icon} tone={tone} />
      {children}
    </h3>
  );
}
