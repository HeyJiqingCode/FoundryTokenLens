import { apiErrorMessage, type ApiErrorBody } from '../shared/api-error';
import { message, isMessageKey, type DisplayMessage } from './i18n';
import { reportReachable, reportUnreachable } from './connection';

/** Reported while the service restarts or cannot be reached; the connection notice covers it. */
export const SERVICE_UNAVAILABLE = 'errors.serviceUnavailable';
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

class RequestError extends Error {
  constructor(readonly displayMessage: DisplayMessage) {
    super(typeof displayMessage === 'string' ? displayMessage : displayMessage.key);
  }
}
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    signal: options.signal,
    headers: {
      'X-FTL-Request': '1',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }).catch((error: unknown) => {
    if (options.signal?.aborted) throw error;
    reportUnreachable();
    throw new RequestError(SERVICE_UNAVAILABLE);
  });
  if (UNAVAILABLE_STATUSES.has(response.status)) {
    reportUnreachable();
    throw new RequestError(SERVICE_UNAVAILABLE);
  }
  reportReachable();
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/sign-in/'))
      window.dispatchEvent(new Event('ftl:unauthorized'));
    const code = String(value.code ?? '');
    if (isMessageKey(code))
      throw new RequestError(apiErrorMessage(value as unknown as ApiErrorBody));
    if (typeof value.message === 'string' && isMessageKey(value.message))
      throw new RequestError(value.message);
    if (code.includes('INVALID_EMAIL_OR_PASSWORD'))
      throw new RequestError('auth.invalidCredentials');
    if (code.includes('INVALID_PASSWORD')) throw new RequestError('auth.invalidCurrentPassword');
    if (code === 'USER_BANNED') throw new RequestError('auth.userBanned');
    if (response.status === 429) throw new RequestError('errors.rateLimited');
    throw new RequestError(
      typeof value.error === 'string'
        ? value.error
        : typeof value.message === 'string'
          ? value.message
          : message('errors.httpStatus', { status: response.status }),
    );
  }
  return value as T;
}

export function errorMessage(error: unknown): DisplayMessage {
  if (error instanceof RequestError) return error.displayMessage;
  return error instanceof Error ? error.message : 'errors.operationFailed';
}
