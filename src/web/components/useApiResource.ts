import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import type { DisplayMessage } from '../i18n';

/**
 * Loads a GET resource and reloads it whenever `revision` changes; a superseded response is
 * dropped. `loading` lasts until the first answer for the path, so a reload keeps the content.
 */
export function useApiResource<T>(path: string, revision: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DisplayMessage | null>(null);
  const [answered, setAnswered] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void api<T>(path, { signal: abort.signal })
      .then((value) => {
        if (abort.signal.aborted) return;
        setData(value);
        setError(null);
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setAnswered(path);
      });
    return () => abort.abort();
  }, [path, revision]);
  return { data, error, loading: answered !== path };
}
