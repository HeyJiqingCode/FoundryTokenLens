import type { MessageKey } from './i18n/translate.js';

export const ENTRA_LOGIN_ERRORS = {
  ENTRA_TENANT_NOT_ALLOWED: 'auth.organizationIsNotAllowedToSignInTo',
  ENTRA_LOGIN_EXPIRED: 'auth.microsoftSignInSessionExpired',
  ENTRA_TOKEN_MISSING: 'auth.microsoftDidNotReturnAnIDToken',
  ENTRA_TOKEN_INVALID: 'auth.microsoftIDTokenValidationFailed',
  ENTRA_PROFILE_INVALID: 'auth.microsoftReturnedIncompleteUserIdentityInformation',
  ENTRA_SETTINGS_CHANGED: 'auth.entraSignInSettingsHaveChanged',
} as const satisfies Record<string, MessageKey>;

export function entraLoginError(query: URLSearchParams): MessageKey | null {
  const kind = query.get('auth_error');
  if (!kind) return null;
  if (Object.hasOwn(ENTRA_LOGIN_ERRORS, kind))
    return ENTRA_LOGIN_ERRORS[kind as keyof typeof ENTRA_LOGIN_ERRORS];
  const error = query.get('error');
  if (error && ['state_not_found', 'state_mismatch', 'state_verification_failed'].includes(error))
    return ENTRA_LOGIN_ERRORS.ENTRA_LOGIN_EXPIRED;
  if (error === 'unable_to_get_user_info') return 'auth.couldNotRetrieveOrValidateTheMicrosoftUser';
  if (error === 'invalid_code') return 'auth.microsoftAuthorizationCodeExchangeFailed';
  return 'auth.entraSignInWasNotCompleted';
}
