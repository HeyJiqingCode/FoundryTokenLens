import { createLogStore, type LogStore } from './platform/log-store.js';
import { mergeRequestRecords, type ParsedRecord } from './ingestion/parser.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { RequestFact } from '../shared/ingestion.js';

// No migrations: a database is created at this schema or refused, so a schema change means
// bumping the version and starting with an empty data directory.
const SCHEMA_VERSION = 14;

const FULL_SCHEMA = `
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json)),
    updated_at TEXT NOT NULL
  );
  CREATE TABLE price_versions (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, model TEXT NOT NULL,
    model_version TEXT NOT NULL, region TEXT NOT NULL, deployment_type TEXT NOT NULL,
    valid_from TEXT, valid_to TEXT,
    items_json TEXT NOT NULL CHECK (json_valid(items_json)),
    notes TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    context_pricing_json TEXT CHECK (context_pricing_json IS NULL OR json_valid(context_pricing_json)),
    UNIQUE (scope_key, valid_from)
  );
  CREATE UNIQUE INDEX price_unbounded_start ON price_versions(scope_key) WHERE valid_from IS NULL;
  CREATE TABLE import_blobs (
    source_key TEXT NOT NULL, container TEXT NOT NULL, name TEXT NOT NULL,
    resource_id TEXT NOT NULL, resource_prefix TEXT NOT NULL, blob_time TEXT NOT NULL,
    etag TEXT NOT NULL, size INTEGER NOT NULL, blob_type TEXT NOT NULL, created_on TEXT,
    checkpoint_etag TEXT, checkpoint_created_on TEXT, byte_offset INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
    retry_at TEXT, error TEXT,
    PRIMARY KEY (source_key, container, name)
  );
  CREATE INDEX import_pending ON import_blobs (source_key, complete, retry_at, blob_time);
  CREATE TABLE diagnostic_records (
    source_key TEXT NOT NULL, hash TEXT NOT NULL, category TEXT NOT NULL,
    resource_id TEXT NOT NULL, correlation_id TEXT, time TEXT NOT NULL,
    container TEXT NOT NULL, blob_name TEXT NOT NULL, byte_offset INTEGER NOT NULL,
    raw_json TEXT NOT NULL, normalized_json TEXT NOT NULL,
    PRIMARY KEY (source_key, hash)
  );
  CREATE INDEX diagnostic_request ON diagnostic_records (source_key, resource_id, correlation_id, category);
  CREATE TABLE request_facts (
    source_key TEXT NOT NULL, resource_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
    time TEXT NOT NULL, is_inference INTEGER NOT NULL, fact_json TEXT NOT NULL,
    usage_hash TEXT, request_hash TEXT,
    PRIMARY KEY (source_key, resource_id, correlation_id)
  );
  CREATE INDEX request_time ON request_facts (source_key, is_inference, time DESC);
  CREATE INDEX request_model_time ON request_facts (source_key, json_extract(fact_json, '$.model'), time);
  CREATE INDEX request_status_time ON request_facts (source_key, json_extract(fact_json, '$.statusCode'), time);
  CREATE TABLE import_issues (
    source_key TEXT NOT NULL, container TEXT NOT NULL, blob_name TEXT NOT NULL,
    byte_offset INTEGER NOT NULL, hash TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (source_key, container, blob_name, byte_offset, hash)
  );
  CREATE TABLE import_runs (
    id TEXT PRIMARY KEY, source_key TEXT NOT NULL, mode TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL,
    imported_records INTEGER NOT NULL DEFAULT 0, downloaded_bytes INTEGER NOT NULL DEFAULT 0,
    list_calls INTEGER NOT NULL DEFAULT 0, read_calls INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0, message TEXT,
    trigger TEXT CHECK (trigger IN ('scheduled', 'manual')), actor TEXT
  );
  CREATE INDEX import_run_time ON import_runs (source_key, started_at DESC);
  CREATE TABLE request_costs (
    source_key TEXT NOT NULL, resource_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
    result_json TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (source_key, resource_id, correlation_id)
  );
  CREATE TABLE source_statistics (
    source_id TEXT PRIMARY KEY, scope TEXT NOT NULL, files INTEGER NOT NULL,
    bytes TEXT NOT NULL, checked_at TEXT NOT NULL
  );
  CREATE TABLE task_executions (
    task_id TEXT NOT NULL, slot TEXT NOT NULL, started_at TEXT NOT NULL,
    PRIMARY KEY (task_id, slot)
  );
  CREATE TABLE review_progress (
    task_id TEXT NOT NULL, source_key TEXT NOT NULL, container TEXT NOT NULL,
    last_success_at TEXT, completed_at TEXT, active_until TEXT, active_from TEXT,
    marker TEXT, listing_done INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, source_key, container)
  );
  CREATE TABLE review_files (
    task_id TEXT NOT NULL, source_key TEXT NOT NULL, container TEXT NOT NULL,
    name TEXT NOT NULL, required_size INTEGER NOT NULL,
    PRIMARY KEY (task_id, source_key, container, name)
  );
  CREATE TABLE system_logs (
    id TEXT NOT NULL UNIQUE, time TEXT NOT NULL, category TEXT NOT NULL,
    level TEXT NOT NULL, action TEXT NOT NULL, source_key TEXT,
    content_json TEXT NOT NULL CHECK (json_valid(content_json))
  );
  CREATE INDEX system_logs_time ON system_logs (time);
  CREATE INDEX system_logs_source ON system_logs (source_key, time);
  CREATE TABLE record_locations (
    source_key TEXT NOT NULL, hash TEXT NOT NULL, container TEXT NOT NULL,
    blob_name TEXT NOT NULL, byte_offset INTEGER NOT NULL,
    PRIMARY KEY (source_key, container, blob_name, byte_offset, hash)
  );
  CREATE TABLE task_pending (
    task_id TEXT NOT NULL, slot TEXT NOT NULL, source_id TEXT NOT NULL,
    due_at TEXT NOT NULL, task_revision TEXT NOT NULL,
    PRIMARY KEY (task_id, slot, source_id)
  );
  CREATE TABLE scheduler_state (id INTEGER PRIMARY KEY CHECK (id = 1), checked_at TEXT NOT NULL);
`;

export interface AppDatabase {
  connection: Database.Database;
  instanceId: string;
  logs: LogStore;
  schemaVersion: number;
  dataRevision(): string;
  /** Request facts or prices changed, so some request costs need recalculating. */
  markCostsDirty(): void;
  /** Returns whether costs were marked dirty since the last call, and clears the mark. */
  takeCostsDirty(): boolean;
  close(): void;
}

export function openDatabase(dataDir: string): AppDatabase {
  mkdirSync(dataDir, { recursive: true });
  const connection = new Database(join(dataDir, 'foundry-token-lens.sqlite'), {
    timeout: 5_000,
  });

  try {
    connection.function('ftl_merge_facts', { deterministic: true }, (raw: unknown) => {
      const facts = (JSON.parse(String(raw)) as string[]).map((value) =>
        JSON.parse(value),
      ) as RequestFact[];
      const records: ParsedRecord[] = [];
      for (const [index, fact] of facts.entries())
        for (const category of ['usage', 'requests'] as const) {
          if (category === 'usage' ? !fact.hasUsage : !fact.hasRequest) continue;
          records.push({
            hash: `${index}/${category}`,
            category,
            resourceId: fact.resourceId,
            correlationId: fact.correlationId,
            time: fact.time,
            raw: '',
            fact,
            inference: fact.requestKind !== 'other',
            placeholder: category === 'requests' && fact.responsePlaceholder === true,
          });
        }
      const merged = mergeRequestRecords(records);
      merged.usageRecordCount = facts.reduce((n, fact) => n + (fact.usageRecordCount ?? 0), 0);
      merged.responseRecordCount = facts.reduce(
        (n, fact) => n + (fact.responseRecordCount ?? 0),
        0,
      );
      return JSON.stringify(merged);
    });
    const current = connection.pragma('user_version', { simple: true }) as number;
    if (current !== 0 && current !== SCHEMA_VERSION) {
      throw new Error(
        `Database schema ${current} does not match this app (${SCHEMA_VERSION}); start with an empty data directory.`,
      );
    }

    // No WAL default: deployments may mount the data directory via a file share.
    // A mounted filesystem must still provide SQLite-compatible locking and sync.
    connection.pragma('journal_mode = DELETE');
    connection.pragma('synchronous = FULL');
    connection.pragma('foreign_keys = ON');

    connection
      .transaction(() => {
        if (current === 0) {
          connection.exec(FULL_SCHEMA);
          connection.pragma(`user_version = ${SCHEMA_VERSION}`);
        }
        connection
          .prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)')
          .run('instance_id', randomUUID());
      })
      .immediate();

    const instance = connection
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('instance_id') as { value: string };

    // Per-connection, transactional invalidation: unrelated audit/scheduler writes do not evict reports.
    connection.exec(
      'CREATE TEMP TABLE analytics_revision(value INTEGER NOT NULL); INSERT INTO analytics_revision VALUES(0)',
    );
    for (const table of ['request_facts', 'request_costs', 'price_versions'])
      for (const action of ['INSERT', 'UPDATE', 'DELETE'])
        connection.exec(
          `CREATE TEMP TRIGGER analytics_${table}_${action} AFTER ${action} ON main.${table} BEGIN UPDATE analytics_revision SET value=value+1; END`,
        );
    const revision = connection.prepare('SELECT value FROM analytics_revision');
    let costsDirty = false;
    return {
      connection,
      instanceId: instance.value,
      logs: createLogStore(connection),
      schemaVersion: SCHEMA_VERSION,
      dataRevision() {
        return `${(revision.get() as { value: number }).value}/${connection.pragma('data_version', { simple: true })}`;
      },
      markCostsDirty() {
        costsDirty = true;
      },
      takeCostsDirty() {
        const dirty = costsDirty;
        costsDirty = false;
        return dirty;
      },
      close() {
        connection.close();
      },
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}
