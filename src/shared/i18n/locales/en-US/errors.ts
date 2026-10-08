import type source from '../zh-CN/errors.js';
import type { LocaleMessages } from '../../types.js';

export default {
  'errors.fieldValidation': '{field}: {error}',
  'errors.joinMessages': '{first}; {next}',
  'errors.recordConflict': 'The record already exists or conflicts with the current configuration.',
  'errors.invalidRequest': 'The request format is invalid.',

  'errors.pageFailed': 'This page could not be displayed',
  'errors.pageFailedHint': 'Try again, or open another page from the menu.',
  'errors.retryPage': 'Try again',

  'errors.serviceUnavailable': 'The service is temporarily unavailable. Reconnecting…',
  'errors.serviceUnavailableTitle': 'Service temporarily unavailable',
  'errors.serviceUnavailableHint': 'Reconnecting automatically; you will continue once it is back.',
  'errors.invalidValue': 'Enter a valid value.',
  'errors.invalidId': 'Enter a valid ID (UUID).',
  'errors.invalidFormat': 'Invalid input format.',
  'errors.invalidSelection': 'Choose a valid option.',
  'errors.unsupportedFields': 'The request contains unsupported fields.',
  'errors.minLength': {
    one: 'Enter at least {count} character.',
    other: 'Enter at least {count} characters.',
  },
  'errors.maxLength': {
    one: 'Enter no more than {count} character.',
    other: 'Enter no more than {count} characters.',
  },
  'errors.minItems': {
    one: 'Include at least {count} item.',
    other: 'Include at least {count} items.',
  },
  'errors.maxItems': {
    one: 'Include no more than {count} item.',
    other: 'Include no more than {count} items.',
  },
  'errors.minimumValue': 'The value must be at least {count}.',
  'errors.maximumValue': 'The value must be at most {count}.',
  'errors.greaterThan': 'The value must be greater than {count}.',
  'errors.lessThan': 'The value must be less than {count}.',
  'errors.httpStatus': 'Request failed ({status}).',
  'errors.operationFailed': 'The operation failed. Please try again.',
  'errors.operationIncomplete': 'The operation could not be completed. Please try again later.',
  'errors.rateLimited': 'Too many requests. Please try again later.',
} satisfies LocaleMessages<typeof source>;
