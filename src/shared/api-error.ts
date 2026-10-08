import {
  isMessageKey,
  message,
  type Message,
  type MessageKey,
  type MessageParams,
} from './i18n/translate.js';
export interface ApiIssue {
  code: MessageKey;
  params?: MessageParams;
  path?: string;
}
export interface ApiErrorBody extends ApiIssue {
  issues?: ApiIssue[];
}
const fields: Record<string, MessageKey> = {
  name: 'auth.displayName',
  displayName: 'pricing.displayName',
  email: 'auth.email',
  newEmail: 'auth.email',
  password: 'auth.password',
  currentPassword: 'auth.currentPassword',
  newPassword: 'auth.newPassword',
  role: 'auth.role',
  clientId: 'auth.clientId',
  clientSecret: 'auth.clientSecret',
  allowedTenantIds: 'auth.tenantIds',
  tenantId: 'auth.tenantIds',
  publicUrl: 'auth.publicUrl',
  model: 'common.model',
};
export function apiErrorMessage(body: ApiErrorBody): Message {
  const messages = (body.issues?.length ? body.issues : [body]).map((issue) => {
    const text = message(
      isMessageKey(issue.code) ? issue.code : 'errors.invalidValue',
      issue.params,
    );
    if (!issue.path) return text;
    const field = issue.path
      .split('.')
      .filter((part) => !/^\d+$/.test(part))
      .at(-1)!;
    return message('errors.fieldValidation', {
      field: fields[field] ? message(fields[field]) : field,
      error: text,
    });
  });
  return messages.reduce((first, next) => message('errors.joinMessages', { first, next }));
}
