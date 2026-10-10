import type { RequestCost } from './pricing.js';
export type LogCategory = 'usage' | 'requests';
export type RunMode = 'scan' | 'reconcile';

// Decimal strings preserve the full non-negative int64 range across JSON/JavaScript.
export interface RequestFact {
  resourceId: string;
  correlationId: string;
  time: string;
  /** `start`: when the call was received; `event`: when its log was written, about when it ended. */
  timeSource?: 'start' | 'event' | 'ingestion';
  model: string | null;
  modelVersion: string | null;
  deployment: string | null;
  region: string | null;
  deploymentType?: string | null;
  operation: string | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cachedTokens: string | null;
  cacheWriteTokens: string | null;
  inputTextTokens?: string | null;
  inputImageTokens?: string | null;
  cachedTextTokens?: string | null;
  cachedImageTokens?: string | null;
  outputImageTokens?: string | null;
  durationMs: number | null;
  timeToFirstTokenMs: number | null;
  statusCode: number | null;
  callerIp: string | null;
  hasUsage: boolean;
  hasRequest: boolean;
  streamType?: string | null;
  timeToLastTokenMs?: number | null;
  requestLength?: number | null;
  responseLength?: number | null;
  apiName?: string | null;
  linkState?: 'linked' | 'usage_only' | 'response_only';
  requestKind?: 'model' | 'other';
  responsePlaceholder?: boolean;
  statusConflict?: boolean;
  conflicts?: string[];
  usageRecordCount?: number;
  responseRecordCount?: number;
  cost?: RequestCost | null;
}

export interface ImportRun {
  id: string;
  mode: RunMode;
  trigger: 'scheduled' | 'manual';
  actor?: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  importedRecords: number;
  downloadedBytes: number;
  listCalls: number;
  readCalls: number;
  errorCount: number;
  message: string | null;
  /** Requests this run imported that another data source holds too, so reports count them twice. */
  duplicateRequests: number;
}

export interface IngestionStatus {
  dataRevision?: string;
  configured: boolean;
  running: boolean;
  requestCount: number;
  resourceCount: number;
  pendingBlobs: number;
  pendingScans: number;
  issueCount: number;
  workerError: string | null;
  issues: { container: string; blobName: string; byteOffset: number | null; reason: string }[];
  runs: ImportRun[];
}

export interface RecordEvidence {
  category: LogCategory;
  container: string;
  blobName: string;
  byteOffset: number;
  hash: string;
  sourceKey?: string;
  sourceName?: string;
  locations?: { container: string; blobName: string; byteOffset: number }[];
  raw?: string;
  data?: Record<string, unknown>;
}
