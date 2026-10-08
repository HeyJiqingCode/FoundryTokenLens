import type { ReactNode } from 'react';

export function Pill({
  children,
  tone = 'neutral',
  capsule = false,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
  capsule?: boolean;
}) {
  return (
    <span className={`pill ${tone}${capsule ? ' pill-capsule' : ''}`}>
      {!capsule && <span className="status-dot" />}
      {children}
    </span>
  );
}
