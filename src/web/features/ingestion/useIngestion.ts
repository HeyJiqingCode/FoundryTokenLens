import type { DisplayMessage } from '../../i18n';
import { useCallback, useEffect, useState } from 'react';
import type { IngestionStatus } from '../../../shared/ingestion';
import { useVisibility } from '../analytics/useVisibility';
import { api, errorMessage } from '../../api';

export function useIngestion() {
  const visible = useVisibility();
  const [status, setStatus] = useState<IngestionStatus | null>(null);
  const [error, setError] = useState<DisplayMessage | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let interval = 30000;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await api<IngestionStatus>('/api/ingestion', { signal: abort.signal });
        if (!cancelled) {
          interval = result.running ? 5000 : 30000;
          setStatus(result);
          setError(null);
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason));
      } finally {
        if (!cancelled)
          timer = setTimeout(() => {
            void load();
          }, interval);
      }
    }
    void load();
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [version, visible]);
  return { status, error, refresh };
}
