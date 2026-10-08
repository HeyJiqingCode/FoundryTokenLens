import { auditDetails } from './audit-format.js';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import type { LogPolicy, SystemData, SystemLogPage } from '../../shared/platform.js';
import type { ImportRun } from '../../shared/ingestion.js';
import { sourceKey } from '../ingestion/parser.js';

export const LOG_DATA_TABLES = [
  'record_locations',
  'diagnostic_records',
  'request_facts',
  'request_costs',
  'import_blobs',
  'import_issues',
  'review_files',
  'review_progress',
] as const;
export function createPlatformService(database: AppDatabase, settings: SettingsRepository) {
  const db = database.connection;
  const systemTables = ['system_logs'];
  const count = (table: string) =>
    (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  function data(): SystemData {
    database.logs.prune();
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const pages = db.pragma('page_count', { simple: true }) as number;
    const free = db.pragma('freelist_count', { simple: true }) as number;
    let logBytes: number | null = null,
      otherBytes: number | null = null,
      systemLogDatabaseBytes: number | null = null;
    try {
      const sizes = db
        .prepare(
          `SELECT coalesce(s.tbl_name,d.name) tableName, sum(d.pgsize) bytes FROM dbstat d LEFT JOIN sqlite_schema s ON s.name=d.name GROUP BY coalesce(s.tbl_name,d.name)`,
        )
        .all() as { tableName: string; bytes: number }[];
      logBytes = sizes
        .filter((s) => LOG_DATA_TABLES.some((table) => table === s.tableName))
        .reduce((sum, s) => sum + s.bytes, 0);
      otherBytes = sizes
        .filter(
          (s) =>
            !LOG_DATA_TABLES.some((table) => table === s.tableName) &&
            !systemTables.includes(s.tableName),
        )
        .reduce((sum, s) => sum + s.bytes, 0);
      systemLogDatabaseBytes = sizes
        .filter((s) => systemTables.includes(s.tableName))
        .reduce((sum, s) => sum + s.bytes, 0);
    } catch {
      /* Some SQLite builds omit dbstat; counts remain available. */
    }
    return {
      records: count('diagnostic_records'),
      requests: count('request_facts'),
      logBytes,
      otherBytes,
      freeBytes: free * pageSize,
      databaseBytes: pages * pageSize,
      systemLogBytes: systemLogDatabaseBytes ?? database.logs.size(),
      systemLogDatabaseBytes,
    };
  }
  function flushRuns() {
    if (db.inTransaction) return;
    const rows = db
      .prepare("SELECT DISTINCT source_key FROM import_runs WHERE status<>'running'")
      .all() as { source_key: string }[];
    for (const { source_key } of rows) {
      const runs = db
        .prepare(
          "SELECT id,mode,trigger,actor,started_at startedAt,finished_at finishedAt,status,imported_records importedRecords,downloaded_bytes downloadedBytes,list_calls listCalls,read_calls readCalls,error_count errorCount,message FROM import_runs WHERE source_key=? AND status<>'running' ORDER BY started_at",
        )
        .all(source_key) as ImportRun[];
      for (const run of runs) {
        db.transaction(() => {
          database.logs.append({
            id: run.id,
            time: run.finishedAt ?? run.startedAt,
            category: 'task',
            level:
              run.status === 'failed'
                ? 'error'
                : run.status === 'partial' || run.status === 'interrupted'
                  ? 'warning'
                  : 'info',
            action: run.trigger,
            subject:
              settings.getSources().find((source) => sourceKey(source) === source_key)
                ?.accountName ?? source_key,
            actor: run.actor ?? (run.trigger === 'scheduled' ? 'Scheduler' : ''),
            status: run.status,
            details: `${run.mode === 'reconcile' ? 'reconciliation' : 'import'}; started=${run.startedAt}; records=${run.importedRecords}; bytes=${run.downloadedBytes}; errors=${run.errorCount}${run.message ? '; ' + run.message : ''}`,
            sourceKey: source_key,
            run,
          });
          db.prepare('DELETE FROM import_runs WHERE id=?').run(run.id);
        })();
      }
    }
  }
  const flush = flushRuns;
  function logs(filters: {
    category?: string;
    level?: string;
    search?: string;
    limit: number;
    offset: number;
  }): SystemLogPage {
    flush();
    const result = database.logs.query(filters);
    return {
      total: result.total,
      logs: result.logs.map(
        ({ id, time, category, level, action, subject, actor, status, details }) => ({
          id,
          time,
          category,
          level,
          action,
          subject,
          actor,
          status,
          details,
        }),
      ),
    };
  }
  function clearLogs() {
    db.transaction(() => {
      database.logs.clear();
      db.exec("DELETE FROM import_runs WHERE status<>'running'");
    }).immediate();
  }
  function reclaimSpace() {
    if ((db.pragma('freelist_count', { simple: true }) as number) > 0) db.exec('VACUUM');
  }
  function saveLogPolicy(value: LogPolicy, actor: string) {
    return db.transaction(() => {
      const before = database.logs.policy();
      const result = database.logs.savePolicy(value);
      database.logs.append({
        id: randomUUID(),
        time: new Date().toISOString(),
        category: 'operation',
        level: 'info',
        action: 'log_policy.update',
        subject: 'log_policy',
        actor,
        status: 'succeeded',
        details: auditDetails(before, value, 'log_policy.update'),
      });
      return result;
    })();
  }
  return {
    data,
    logs,
    clearLogs,
    flush,
    reclaimSpace,
    logPolicy: database.logs.policy,
    saveLogPolicy,
  };
}
