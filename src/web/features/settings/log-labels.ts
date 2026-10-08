import type { LOG_EVENT_TYPES, SystemLog } from '../../../shared/platform';
import { t, type MessageKey } from '../../i18n';

export const LOG_CATEGORY_LABELS = {
  task: 'platform.taskLogs',
  operation: 'platform.operationLogs',
  system: 'platform.runtimeLogs',
} as const satisfies Record<SystemLog['category'], MessageKey>;

export const LOG_LEVEL_LABELS = {
  info: 'platform.infoLevel',
  warning: 'platform.warningLevel',
  error: 'platform.errorLevel',
} as const satisfies Record<SystemLog['level'], MessageKey>;

export const LOG_LEVEL_TONES = {
  info: 'neutral',
  warning: 'warning',
  error: 'error',
} as const satisfies Record<SystemLog['level'], string>;

/** The event types a log policy can record. */
export const LOG_EVENT_LABELS = {
  scheduled: 'platform.scheduledScan',
  manual: 'platform.manualScan',
  create: 'platform.createEvent',
  update: 'platform.updateEvent',
  delete: 'platform.deleteEvent',
} as const satisfies Record<(typeof LOG_EVENT_TYPES)[number], MessageKey>;

const ACTION_LABELS = new Map<string, MessageKey>([
  ['scheduled', LOG_EVENT_LABELS.scheduled],
  ['manual', LOG_EVENT_LABELS.manual],
  ['platform.started', 'platform.started'],
  ['platform.http', 'platform.httpRequest'],
]);

const STATUS_LABELS = new Map<string, MessageKey>([
  ['running', 'common.running'],
  ['succeeded', 'common.completed'],
  ['partial', 'common.partial'],
  ['interrupted', 'common.interrupted'],
]);

/** Known actions are translated; any other action is shown as recorded. */
export function logActionLabel(action: string) {
  const key = ACTION_LABELS.get(action);
  return key ? t(key) : action;
}

/** Any status other than the known ones is a failure. */
export function logStatusLabel(status: string) {
  return status ? t(STATUS_LABELS.get(status) ?? 'common.failed') : '—';
}
