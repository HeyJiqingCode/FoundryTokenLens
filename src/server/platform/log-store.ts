import type Database from 'better-sqlite3';
import { DEFAULT_LOG_POLICY, type LogPolicy, type SystemLog } from '../../shared/platform.js';

export type StoredLog = SystemLog & {
  sourceKey?: string;
  run?: import('../../shared/ingestion.js').ImportRun;
};
function logEventType(entry: SystemLog): LogPolicy['eventTypes'][number] | null {
  if (entry.category === 'task')
    return entry.action === 'scheduled' || entry.action === 'manual' ? entry.action : null;
  if (entry.category !== 'operation') return null;
  if (/(delete|remove|clear|resetHistory|clearLogData)$/.test(entry.action)) return 'delete';
  if (/(create|add)$/.test(entry.action)) return 'create';
  return 'update';
}
export function createLogStore(db: Database.Database, now = () => new Date()) {
  let checkedAt = 0;
  let addedBytes = 0;
  let checkedBytes = 0;
  const insert = db.prepare(`INSERT OR IGNORE INTO system_logs
    (id,time,category,level,action,source_key,content_json) VALUES (?,?,?,?,?,?,?)`);
  function storedPolicy(): LogPolicy {
    const row = db.prepare("SELECT value_json FROM settings WHERE key='log_policy'").get() as
      { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : structuredClone(DEFAULT_LOG_POLICY);
  }
  // savePolicy is the only writer, so the stored policy is read once per store.
  let current: LogPolicy | null = null;
  const policy = () => (current ??= storedPolicy());
  function size(): number {
    return (
      db
        .prepare(
          `SELECT coalesce(sum(pgsize),0) bytes FROM dbstat WHERE name='system_logs'
      OR name IN (SELECT name FROM sqlite_schema WHERE tbl_name='system_logs' AND type='index')`,
        )
        .get() as { bytes: number }
    ).bytes;
  }
  function prune(force = false) {
    const config = policy();
    const maxBytes = config.maxSizeMiB * 1024 * 1024;
    if (!force && now().getTime() - checkedAt < 60000 && checkedBytes + addedBytes < maxBytes)
      return;
    db.transaction(() => {
      db.prepare('DELETE FROM system_logs WHERE time < ?').run(
        new Date(now().getTime() - config.retentionDays * 86400000).toISOString(),
      );
      let bytes = size();
      while (bytes > maxBytes) {
        const oldest = db
          .prepare(
            `SELECT length(CAST(content_json AS BLOB)) bytes
          FROM system_logs ORDER BY time,rowid LIMIT 100`,
          )
          .all() as { bytes: number }[];
        if (!oldest.length) break;
        // Size the batch from the oldest records themselves, not the table average.
        // Keep the batch below the excess; finish one row at a time near the limit.
        let contentBytes = 0;
        let batch = 0;
        for (const row of oldest) {
          if (contentBytes + row.bytes > bytes - maxBytes) break;
          contentBytes += row.bytes;
          batch++;
        }
        batch = Math.max(1, batch);
        const removed = db
          .prepare(
            `DELETE FROM system_logs WHERE rowid IN
          (SELECT rowid FROM system_logs ORDER BY time,rowid LIMIT ?)`,
          )
          .run(batch).changes;
        if (!removed) break;
        bytes = size();
      }
      checkedBytes = bytes;
    })();
    checkedAt = now().getTime();
    addedBytes = 0;
  }
  /** Writes a log the policy keeps; pruning happens on the periodic and read paths. */
  function append(entry: StoredLog) {
    const config = policy();
    const type = logEventType(entry);
    if (!type || !config.eventTypes.includes(type) || !config.levels.includes(entry.level)) return;
    const json = JSON.stringify(entry);
    const result = insert.run(
      entry.id,
      entry.time,
      entry.category,
      entry.level,
      entry.action,
      entry.sourceKey ?? null,
      json,
    );
    if (result.changes) addedBytes += Buffer.byteLength(json) * 2;
  }
  function query(filters: {
    category?: string;
    level?: string;
    search?: string;
    limit: number;
    offset: number;
    sourceKey?: string;
  }) {
    prune();
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ['category', filters.category],
      ['level', filters.level],
      ['source_key', filters.sourceKey],
    ]) {
      if (value) {
        conditions.push(`${column}=?`);
        params.push(value);
      }
    }
    if (filters.search) {
      conditions.push(
        `instr(lower(action || ' ' || json_extract(content_json,'$.subject') || ' ' || json_extract(content_json,'$.actor') || ' ' || json_extract(content_json,'$.details')),lower(?))>0`,
      );
      params.push(filters.search);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const total = (
      db.prepare(`SELECT count(*) n FROM system_logs ${where}`).get(...params) as { n: number }
    ).n;
    const logs = (
      db
        .prepare(
          `SELECT content_json FROM system_logs ${where} ORDER BY time DESC,rowid DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, filters.limit, filters.offset) as { content_json: string }[]
    ).map((row) => JSON.parse(row.content_json) as StoredLog);
    return { logs, total };
  }
  function savePolicy(value: LogPolicy) {
    db.prepare(
      `INSERT INTO settings(key,value_json,updated_at) VALUES ('log_policy',?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    ).run(JSON.stringify(value), now().toISOString());
    current = null;
    prune(true);
    return policy();
  }
  function clear() {
    db.exec('DELETE FROM system_logs');
    checkedBytes = size();
    addedBytes = 0;
  }
  return { append, query, clear, size, policy, savePolicy, prune };
}
export type LogStore = ReturnType<typeof createLogStore>;
