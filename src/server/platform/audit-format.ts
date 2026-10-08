import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database.js';
// Explicit allowlist: never copy credentials, raw requests, or arbitrary nested data.
const fields = [
  'maxSizeMiB',
  'retentionDays',
  'eventTypes',
  'levels',
  'name',
  'displayName',
  'email',
  'role',
  'enabled',
  'authMode',
  'accountName',
  'endpoint',
  'managedIdentityClientId',
  'containers',
  'sourceIds',
  'timezone',
  'type',
  'hour',
  'frequencyDays',
  'daytime',
  'nighttime',
  'model',
  'modelVersion',
  'region',
  'deploymentType',
  'validFrom',
  'validTo',
  'items',
  'contextPricing',
  'defaultAdmin',
  'allowedTenantIds',
  'clientId',
  'publicUrl',
  'startTime',
  'endTime',
  'intervalMinutes',
  'threshold',
  'longItems',
  'key',
  'label',
  'unitQuantity',
  'unitPriceUsd',
  'scope',
  'scopeKey',
  'groupKey',
  'sourceKey',
  'currencyCode',
  'meterName',
  'retailPrice',
  'unitOfMeasure',
] as const;
export function safeAudit(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    fields
      .filter((key) => record[key] !== undefined)
      .map((key) => {
        const value = record[key];
        if (Array.isArray(value))
          return [
            key,
            value.map((item) =>
              typeof item === 'object' && item !== null ? safeAudit(item) : item,
            ),
          ];
        if (typeof value === 'object' && value !== null) return [key, safeAudit(value)];
        return [key, value];
      }),
  );
}
export function auditDetails(
  before: unknown,
  after: unknown,
  action: string,
  secretChanged = false,
) {
  const old = safeAudit(before),
    next = safeAudit(after);
  const changes = Object.keys(next)
    .filter((key) => JSON.stringify(old[key]) !== JSON.stringify(next[key]))
    .map(
      (key) =>
        `${key}: ${old[key] === undefined ? '—' : JSON.stringify(old[key])} → ${JSON.stringify(next[key])}`,
    );
  if (action.includes('delete') || action.endsWith('.remove'))
    changes.splice(
      0,
      changes.length,
      ...Object.entries(old).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    );
  if (secretChanged || action.includes('password')) changes.push('credential: updated');
  return changes.join('; ').slice(0, 16000) || action;
}

/** Logs one settings change inside the caller's transaction, so it commits or rolls back with it. */
export function recordAudit(
  database: AppDatabase,
  change: {
    actor: string;
    action: string;
    subject: string;
    before: unknown;
    after?: unknown;
    secretChanged?: boolean;
  },
) {
  const before = safeAudit(change.before);
  const after = change.after == null ? null : safeAudit(change.after);
  let actorName = change.actor;
  try {
    actorName =
      (
        database.connection.prepare('SELECT name FROM user WHERE id=?').get(change.actor) as
          { name: string } | undefined
      )?.name ?? actorName;
  } catch {
    /* Databases opened without authentication have no user table. */
  }
  const object = after ?? before;
  database.logs.append({
    id: randomUUID(),
    time: new Date().toISOString(),
    category: 'operation',
    level: 'info',
    action: change.action,
    subject: String(
      object.accountName ?? object.name ?? object.email ?? object.model ?? change.subject,
    ),
    actor: actorName,
    status: 'succeeded',
    details: auditDetails(before, after, change.action, Boolean(change.secretChanged)),
  });
}
