import type { DisplayMessage } from '../i18n';
import type { Notice } from './Form';

/** Copies text to the clipboard and returns the notice reporting the outcome. */
export async function copyText(
  text: string,
  copied: DisplayMessage,
  failed: DisplayMessage = 'auth.couldNotCopy',
): Promise<Notice> {
  try {
    await navigator.clipboard.writeText(text);
    return { kind: 'success', text: copied };
  } catch {
    return { kind: 'error', text: failed };
  }
}
