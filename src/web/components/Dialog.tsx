import { t, useLocale } from '../i18n';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, type LucideIcon } from 'lucide-react';
import { TitleIcon, type Tone } from './Card';
import { ToastProvider } from './ToastProvider';
import { ScrollViewport } from './ScrollViewport';
import { DialogElementContext } from './dialog-context';

export function Dialog({
  title,
  subtitle,
  subtitleAction,
  headerAction,
  className = '',
  icon,
  tone = 'blue',
  busy,
  autoFocusInput = true,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  subtitleAction?: ReactNode;
  headerAction?: ReactNode;
  className?: string;
  icon?: LucideIcon;
  tone?: Tone;
  busy: boolean;
  autoFocusInput?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useLocale();
  const headingId = useId();
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.setAttribute('closedby', 'none');
    dialog.showModal();
    if (autoFocusInput) dialog.querySelector<HTMLInputElement>('input')?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [dialog, autoFocusInput]);
  return createPortal(
    <dialog
      ref={setDialog}
      className={`app-dialog ${className}`.trim()}
      aria-labelledby={headingId}
      onClickCapture={(event) => {
        if (busy) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return;
        if (event.target instanceof Element && event.target.closest('.toast')) return;
        if (dialog?.querySelector('.picker-popover')) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      <DialogElementContext.Provider value={dialog}>
        <ToastProvider portalTarget={dialog}>
          <ScrollViewport
            className="dialog-viewport"
            contentClassName="dialog-content"
            label={title}
          >
            <header className="dialog-heading">
              <div className="dialog-title">
                <h2 id={headingId}>
                  {icon && <TitleIcon icon={icon} tone={tone} />}
                  {title}
                </h2>
                {subtitle && (
                  <div className="dialog-subtitle">
                    <p>{subtitle}</p>
                    {subtitleAction}
                  </div>
                )}
              </div>
              <div className="dialog-heading-actions">
                {headerAction}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('common.closeNamed', { name: title })}
                  disabled={busy}
                  onClick={onClose}
                >
                  <X size={20} />
                </button>
              </div>
            </header>
            {children}
          </ScrollViewport>
        </ToastProvider>
      </DialogElementContext.Provider>
    </dialog>,
    document.body,
  );
}
