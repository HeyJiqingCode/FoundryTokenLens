import { LocalizedLabel } from './LocalizedLabel';
import { systemMessage, t, useLocale } from '../i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { ScrollViewport } from './ScrollViewport';
import { ToastContext, type ToastInput } from './toast-context';

interface ToastEntry extends ToastInput {
  revision: number;
}

export function ToastProvider({
  children,
  portalTarget,
}: {
  children: ReactNode;
  portalTarget?: HTMLElement | null;
}) {
  useLocale();
  const [messages, setMessages] = useState<ToastEntry[]>([]);
  const dismiss = useCallback((id: string) => {
    setMessages((current) =>
      current.some((item) => item.id === id) ? current.filter((item) => item.id !== id) : current,
    );
  }, []);
  const notify = useCallback((message: ToastInput) => {
    setMessages((current) =>
      [
        {
          ...message,
          revision: (current.find((item) => item.id === message.id)?.revision ?? 0) + 1,
        },
        ...current.filter(
          (item) =>
            item.id !== message.id &&
            !(
              item.kind === message.kind &&
              JSON.stringify(item.text) === JSON.stringify(message.text)
            ),
        ),
      ].slice(0, 4),
    );
  }, []);
  const context = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);
  return (
    <ToastContext.Provider value={context}>
      {children}
      {createPortal(
        <div className="sr-only">
          <div role="status" aria-live="polite" aria-atomic="true">
            {messages
              .filter((item) => item.kind === 'success')
              .map((item) => systemMessage(item.text))
              .join(' ')}
          </div>
          <div role="alert" aria-atomic="true">
            {messages
              .filter((item) => item.kind === 'error')
              .map((item) => systemMessage(item.text))
              .join(' ')}
          </div>
        </div>,
        portalTarget ?? document.body,
      )}
      {messages.length > 0 &&
        createPortal(
          <aside className="toast-viewport" aria-label={t('common.notifications')}>
            <ScrollViewport className="toast-stack" contentClassName="toast-list">
              {messages.map((message) => (
                <ToastItem key={message.id} message={message} dismiss={dismiss} />
              ))}
            </ScrollViewport>
          </aside>,
          portalTarget ?? document.body,
        )}
    </ToastContext.Provider>
  );
}

function ToastItem({ message, dismiss }: { message: ToastEntry; dismiss: (id: string) => void }) {
  useLocale();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !root.current?.contains(active))
      previousFocus.current = active;
  }, [message.revision]);
  const close = useCallback(() => {
    const restore = root.current?.contains(document.activeElement);
    dismiss(message.id);
    if (restore && previousFocus.current?.isConnected) previousFocus.current.focus();
  }, [dismiss, message.id]);
  useEffect(() => {
    if (hovered || focused || message.persistent) return;
    const timer = window.setTimeout(close, 3000);
    return () => window.clearTimeout(timer);
  }, [message.revision, message.persistent, hovered, focused, close]);
  const Icon = message.kind === 'success' ? CircleCheck : CircleAlert;
  return (
    <div
      ref={root}
      className={`toast toast-${message.kind}`}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      <span className="toast-symbol" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className="toast-body">
        <ScrollViewport className="toast-message-viewport">
          <div className="toast-message">{systemMessage(message.text)}</div>
        </ScrollViewport>
        {message.action && (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              message.action?.onClick();
              close();
            }}
          >
            <LocalizedLabel message={message.action.label} />
          </button>
        )}
      </div>
      <button
        className="toast-close"
        type="button"
        aria-label={t('common.dismissNotification')}
        onClick={close}
      >
        <X size={16} />
      </button>
    </div>
  );
}
