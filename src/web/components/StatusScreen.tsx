import type { ReactNode } from 'react';

type Action = { label: string; onClick: () => void };

/** Title, explanation and one action, centered in the space it is given. */
export function StatusMessage({
  title,
  text,
  action,
}: {
  title: string;
  text: ReactNode;
  action?: Action;
}) {
  return (
    <div className="empty-state" role="alert">
      <h2>{title}</h2>
      <p>{text}</p>
      {action && (
        <button type="button" className="button primary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Full-window error or status page: no card, on the sidebar color, centered both ways. */
export function StatusScreen(props: { title: string; text: ReactNode; action?: Action }) {
  return (
    <main className="recovery-screen">
      <StatusMessage {...props} />
    </main>
  );
}
