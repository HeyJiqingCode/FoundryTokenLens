import { ChevronDown } from 'lucide-react';
import type { DisplayMessage } from '../i18n';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react';
import { SERVICE_UNAVAILABLE } from '../api';
import { useToast, type ToastAction } from './toast-context';

export function Field({
  label,
  hint,
  children,
  action,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  const generatedId = useId();
  const control = isValidElement(children)
    ? (children as ReactElement<{ id?: string; 'aria-describedby'?: string }>)
    : null;
  const id = control?.props.id ?? generatedId;
  const renderedControl = control
    ? cloneElement(control, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })
    : children;
  const fieldAction =
    action ??
    (control?.type === 'select' ? (
      <ChevronDown className="field-select-icon" aria-hidden="true" />
    ) : null);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {fieldAction ? (
        <div className="field-with-action">
          {renderedControl}
          {fieldAction}
        </div>
      ) : (
        renderedControl
      )}
      {hint && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

export type Notice = { kind: 'success' | 'error'; text: DisplayMessage } | null;
export function FormNotice({
  notice = null,
  error,
  action,
}: {
  notice?: Notice;
  error?: DisplayMessage | null;
  action?: ToastAction;
}) {
  const id = useId();
  const { notify } = useToast();
  const kind = notice?.kind ?? (error ? 'error' : undefined);
  const text = notice?.text ?? error ?? undefined;
  const actionLabel = action?.label;
  const onAction = action?.onClick;
  useEffect(() => {
    // A lost connection is reported once by the connection notice, not by every request.
    if (kind && text && text !== SERVICE_UNAVAILABLE)
      notify({
        id,
        kind,
        text,
        action: actionLabel && onAction ? { label: actionLabel, onClick: onAction } : undefined,
      });
    // Once published, the toast owns its lifetime. Clearing form or query state
    // during a refresh must not cancel the notification's three-second timer.
  }, [id, notice, kind, text, actionLabel, onAction, notify]);
  return null;
}
