import { useState, type ReactNode } from 'react';
import { Copy, Trash2, type LucideIcon } from 'lucide-react';
import type { DisplayMessage } from '../i18n';
import { Dialog } from './Dialog';
import { Field, FormNotice } from './Form';
import { LocalizedLabel } from './LocalizedLabel';
import { copyText } from './copy-text';
import { useAction } from './useAction';

/** Text the user types to unlock the action; it must match `expected`, ignoring outer spaces. */
type Confirmation = {
  label: ReactNode;
  expected: string;
  caseSensitive?: boolean;
  name?: string;
  maxLength?: number;
  placeholder?: string;
};

/** A destructive action behind Cancel and one danger button; a failure keeps the dialog open. */
export function ConfirmDialog({
  title,
  subtitle,
  subtitleAction,
  icon,
  message,
  confirmation,
  confirmIcon: ConfirmIcon,
  confirmLabel,
  busyLabel,
  action: sharedAction,
  onConfirm,
  onClose,
}: {
  title: string;
  subtitle?: string;
  subtitleAction?: ReactNode;
  icon: LucideIcon;
  message: ReactNode;
  confirmation?: Confirmation;
  confirmIcon?: LucideIcon;
  confirmLabel: ReactNode;
  busyLabel?: ReactNode;
  /** The caller's request state, when other controls report through the same notice. */
  action?: ReturnType<typeof useAction>;
  onConfirm: (typed: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const ownAction = useAction();
  const { busy, notice, run } = sharedAction ?? ownAction;
  const [typed, setTyped] = useState('');
  const value = typed.trim();
  const matches =
    !confirmation ||
    (confirmation.caseSensitive
      ? value === confirmation.expected
      : value.toLowerCase() === confirmation.expected.toLowerCase());
  return (
    <Dialog
      title={title}
      subtitle={subtitle}
      subtitleAction={subtitleAction}
      icon={icon}
      tone="error"
      busy={busy}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && matches)
            void run(async () => {
              await onConfirm(typed);
            });
        }}
      >
        <fieldset disabled={busy}>
          <div className="dialog-confirmation">
            <p>{message}</p>
            {confirmation && (
              <Field label={confirmation.label}>
                <input
                  name={confirmation.name}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  maxLength={confirmation.maxLength}
                  placeholder={confirmation.placeholder}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </Field>
            )}
          </div>
          <footer className="dialog-actions">
            <button className="button secondary" type="button" onClick={onClose}>
              <LocalizedLabel message="common.cancel" />
            </button>
            <button className="button danger" type="submit" disabled={!matches}>
              {ConfirmIcon && <ConfirmIcon size={16} aria-hidden="true" />}
              {busy && busyLabel ? busyLabel : confirmLabel}
            </button>
          </footer>
        </fieldset>
        <FormNotice notice={notice} />
      </form>
    </Dialog>
  );
}

/** Deletion confirmed by typing the item's name, which the button beside the subtitle copies. */
export function TypedDeleteDialog({
  copy,
  confirmation,
  ...props
}: Omit<
  Parameters<typeof ConfirmDialog>[0],
  'icon' | 'confirmIcon' | 'busyLabel' | 'action' | 'subtitleAction' | 'confirmation'
> & {
  copy: { label: string; copied: DisplayMessage };
  confirmation: Confirmation;
}) {
  const action = useAction();
  return (
    <ConfirmDialog
      {...props}
      icon={Trash2}
      confirmIcon={Trash2}
      busyLabel={<LocalizedLabel message="common.deleting" />}
      action={action}
      confirmation={confirmation}
      subtitleAction={
        <button
          className="icon-button accent dialog-subtitle-action"
          type="button"
          disabled={action.busy}
          aria-label={copy.label}
          title={copy.label}
          onClick={async () => action.setNotice(await copyText(confirmation.expected, copy.copied))}
        >
          <Copy size={15} aria-hidden="true" />
        </button>
      }
    />
  );
}
