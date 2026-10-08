import type { ReactNode } from 'react';

/** Workspace title bar: icon and page name, optional section tabs after a divider, and page actions. */
export function PageHeader({
  icon,
  title,
  tabs,
  actions,
}: {
  icon: ReactNode;
  title: string;
  tabs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-title">
        {icon}
        <h1>{title}</h1>
        {tabs && (
          <>
            <span className="page-title-divider" aria-hidden="true" />
            {tabs}
          </>
        )}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
