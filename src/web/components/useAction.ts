import { useState } from 'react';
import { errorMessage } from '../api';
import type { Notice } from './Form';

/**
 * A form or dialog request: `busy` while it runs, its error as the notice when it fails. The action
 * may return the success notice.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  async function run(action: () => Promise<Notice | void>) {
    setBusy(true);
    setNotice(null);
    try {
      const result = await action();
      if (result) setNotice(result);
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, notice, setNotice, run };
}
