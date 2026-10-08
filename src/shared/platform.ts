export interface SystemData {
  records: number;
  requests: number;
  logBytes: number | null;
  otherBytes: number | null;
  freeBytes: number;
  databaseBytes: number;
  systemLogBytes: number;
  systemLogDatabaseBytes: number | null;
}
export interface SystemLog {
  id: string;
  time: string;
  category: 'task' | 'operation' | 'system';
  level: 'info' | 'warning' | 'error';
  action: string;
  subject: string;
  actor: string;
  status: string;
  details: string;
}
export interface SystemLogPage {
  logs: SystemLog[];
  total: number;
}

export const LOG_EVENT_TYPES = ['scheduled', 'manual', 'create', 'update', 'delete'] as const;
export const LOG_LEVELS = ['info', 'warning', 'error'] as const;
export interface LogPolicy {
  maxSizeMiB: number;
  retentionDays: number;
  eventTypes: (typeof LOG_EVENT_TYPES)[number][];
  levels: (typeof LOG_LEVELS)[number][];
}
export const DEFAULT_LOG_POLICY: LogPolicy = {
  maxSizeMiB: 100,
  retentionDays: 30,
  eventTypes: [...LOG_EVENT_TYPES],
  levels: [...LOG_LEVELS],
};

export interface CleanupResult {
  spaceReclaimed: boolean;
}
