import { createContext, useContext } from 'react';
import type { DisplayMessage, MessageKey } from '../i18n';

// Kept apart from ToastProvider.tsx so that hot updates of the component module in development
// do not create a second context that existing consumers no longer find.
export type ToastAction = { label: MessageKey; onClick: () => void };
export interface ToastInput {
  id: string;
  kind: 'success' | 'error';
  text: DisplayMessage;
  action?: ToastAction;
  /** Stays until dismissed or replaced, instead of closing after three seconds. */
  persistent?: boolean;
}
export const ToastContext = createContext<{
  notify: (message: ToastInput) => void;
  dismiss: (id: string) => void;
} | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('ToastProvider is required.');
  return context;
}
