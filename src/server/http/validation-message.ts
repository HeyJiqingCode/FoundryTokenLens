import type { ZodError } from 'zod';
import { isMessageKey } from '../../shared/i18n/translate.js';
import type { ApiIssue } from '../../shared/api-error.js';
export function validationMessage(issue: ZodError['issues'][number]): ApiIssue {
  if (isMessageKey(issue.message)) return { code: issue.message };
  if (issue.code === 'too_small' || issue.code === 'too_big') {
    const minimum = issue.code === 'too_small';
    const bound = minimum ? issue.minimum : issue.maximum;
    const count = typeof bound === 'bigint' ? String(bound) : bound;
    const code =
      issue.origin === 'string'
        ? minimum
          ? 'errors.minLength'
          : 'errors.maxLength'
        : issue.origin === 'array'
          ? minimum
            ? 'errors.minItems'
            : 'errors.maxItems'
          : minimum
            ? issue.inclusive
              ? 'errors.minimumValue'
              : 'errors.greaterThan'
            : issue.inclusive
              ? 'errors.maximumValue'
              : 'errors.lessThan';
    return { code, params: { count } };
  }
  if (issue.code === 'invalid_format')
    return { code: issue.format === 'uuid' ? 'errors.invalidId' : 'errors.invalidFormat' };
  if (issue.code === 'invalid_value') return { code: 'errors.invalidSelection' };
  if (issue.code === 'unrecognized_keys') return { code: 'errors.unsupportedFields' };
  return { code: 'errors.invalidValue' };
}
