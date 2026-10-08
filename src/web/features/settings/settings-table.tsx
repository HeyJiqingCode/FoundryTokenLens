import type { ReactNode } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { MessageKey } from '../../i18n';
import { LocalizedLabel } from '../../components/LocalizedLabel';
import { Pill } from '../../components/Pill';

export function EnabledPill({ enabled }: { enabled: boolean }) {
  return (
    <Pill capsule tone={enabled ? 'success' : 'error'}>
      <LocalizedLabel message={enabled ? 'common.enabled' : 'common.disabled'} />
    </Pill>
  );
}

type RowAction = { label: string; title?: string; disabled?: boolean; onClick: () => void };

/** Edit and delete buttons of a settings row; `children` adds further actions after them. */
export function RowActions({
  className,
  edit,
  remove,
  children,
}: {
  className?: string;
  edit: RowAction;
  remove: RowAction;
  children?: ReactNode;
}) {
  return (
    <div className={className ? `${className} row-actions` : 'row-actions'}>
      <button
        type="button"
        className="icon-button accent"
        aria-label={edit.label}
        title={edit.title ?? edit.label}
        disabled={edit.disabled}
        onClick={edit.onClick}
      >
        <Pencil size={16} aria-hidden="true" />
      </button>
      <span className="row-action-divider" aria-hidden="true" />
      <button
        type="button"
        className="icon-button destructive"
        aria-label={remove.label}
        title={remove.title ?? remove.label}
        disabled={remove.disabled}
        onClick={remove.onClick}
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: MessageKey; hint: MessageKey }) {
  return (
    <div className="empty-state">
      <h3>
        <LocalizedLabel message={title} />
      </h3>
      <p>
        <LocalizedLabel message={hint} />
      </p>
    </div>
  );
}

export function CardLoading({ message = 'common.loadingSettings' }: { message?: MessageKey }) {
  return (
    <p className="card-empty">
      <LocalizedLabel message={message} />
    </p>
  );
}
