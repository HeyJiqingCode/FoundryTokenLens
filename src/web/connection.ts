import { useSyncExternalStore } from 'react';

/**
 * Whether the application service answers. `api` reports each outcome; while the service is
 * unreachable (a restart or deployment) a health probe retries with growing intervals, and
 * `onReconnect` listeners run once it answers again, so pages recover by themselves.
 */
let online = true;
let probe: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const reconnectListeners = new Set<() => void>();

function update(value: boolean) {
  if (online === value) return;
  online = value;
  listeners.forEach((listener) => listener());
  if (value) reconnectListeners.forEach((listener) => listener());
}
function schedule(delay: number) {
  probe = setTimeout(async () => {
    const ok = await fetch('/api/health', { cache: 'no-store' }).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) reportReachable();
    else schedule(Math.min(delay * 2, 15000));
  }, delay);
}

export function reportReachable() {
  clearTimeout(probe);
  probe = undefined;
  update(true);
}
export function reportUnreachable() {
  update(false);
  if (probe === undefined) schedule(1000);
}
export function onReconnect(listener: () => void) {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}
export function useServiceOnline() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => online,
  );
}
