import type { AppDatabase } from '../database.js';
import type { ImportRun, IngestionStatus, RecordEvidence } from '../../shared/ingestion.js';
import type { BlobItem } from './blob-reader.js';
import type { StoredLog } from '../platform/log-store.js';
import { blobPath, parseJson, mergeRequestRecords, type ParsedRecord } from './parser.js';

export interface BlobRow {
  source_key: string;
  container: string;
  name: string;
  resource_id: string;
  resource_prefix: string;
  blob_time: string;
  etag: string;
  size: number;
  blob_type: string;
  created_on: string | null;
  checkpoint_etag: string | null;
  checkpoint_created_on: string | null;
  byte_offset: number;
  complete: number;
  failures: number;
}
export function createImportRepository(database: AppDatabase) {
  const db = database.connection;
  const recordInsert = db.prepare(`INSERT OR IGNORE INTO diagnostic_records
    (source_key, hash, category, resource_id, correlation_id, time, container, blob_name, byte_offset, raw_json, normalized_json)
    VALUES (@source, @hash, @category, @resourceId, @correlationId, @time, @container, @name, @offset, @raw, @normalized)`);
  const locationInsert = db.prepare('INSERT OR IGNORE INTO record_locations VALUES (?,?,?,?,?)');
  const requestRecords = db.prepare(
    'SELECT normalized_json FROM diagnostic_records WHERE source_key=? AND resource_id=? AND correlation_id=? ORDER BY category,hash',
  );
  const costDelete = db.prepare(
    'DELETE FROM request_costs WHERE source_key = ? AND resource_id = ? AND correlation_id = ?',
  );
  const factUpsert = db.prepare(
    `INSERT INTO request_facts (source_key, resource_id, correlation_id, time, is_inference, fact_json, usage_hash, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_key, resource_id, correlation_id)
      DO UPDATE SET time = excluded.time, is_inference = excluded.is_inference, fact_json = excluded.fact_json,
        usage_hash = excluded.usage_hash, request_hash = excluded.request_hash`,
  );
  const blobUpsert = db.prepare(
    `INSERT INTO import_blobs (source_key, container, name, resource_id, resource_prefix, blob_time, etag, size, blob_type, created_on)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, container, name) DO UPDATE SET
      complete = CASE WHEN import_blobs.etag = excluded.etag THEN import_blobs.complete ELSE 0 END,
      retry_at = CASE WHEN import_blobs.etag = excluded.etag THEN import_blobs.retry_at ELSE NULL END,
      failures = CASE WHEN import_blobs.etag = excluded.etag THEN import_blobs.failures ELSE 0 END,
      etag = excluded.etag, size = excluded.size, blob_type = excluded.blob_type, created_on = excluded.created_on`,
  );
  const issueRangeDelete = db.prepare(
    'DELETE FROM import_issues WHERE source_key=? AND container=? AND blob_name=? AND byte_offset>=? AND byte_offset<?',
  );
  const issueInsert = db.prepare('INSERT OR IGNORE INTO import_issues VALUES (?, ?, ?, ?, ?, ?)');
  const checkpointUpdate = db.prepare(
    `UPDATE import_blobs SET checkpoint_etag = ?, checkpoint_created_on = ?, byte_offset = ?, complete = ?,
      failures = 0, retry_at = NULL, error = NULL WHERE source_key = ? AND container = ? AND name = ?`,
  );
  function storeRecord(blob: BlobRow, offset: number, item: ParsedRecord) {
    const inserted = recordInsert.run({
      source: blob.source_key,
      ...item,
      container: blob.container,
      name: blob.name,
      offset,
      normalized: JSON.stringify({ ...item, raw: '' }),
    }).changes;
    locationInsert.run(blob.source_key, item.hash, blob.container, blob.name, offset);
    if (!inserted) return 0;
    const records = (
      requestRecords.all(blob.source_key, item.resourceId, item.correlationId) as {
        normalized_json: string;
      }[]
    ).map((row) => JSON.parse(row.normalized_json) as ParsedRecord);
    const fact = mergeRequestRecords(records);
    costDelete.run(blob.source_key, item.resourceId, item.correlationId);
    factUpsert.run(
      blob.source_key,
      item.resourceId,
      item.correlationId,
      fact.time,
      fact.requestKind === 'model' ? 1 : 0,
      JSON.stringify(fact),
      records.find((record) => record.category === 'usage')?.hash ?? null,
      records.find((record) => record.category === 'requests')?.hash ?? null,
    );
    return 1;
  }
  function savePage(target: { source_key: string; container: string }, items: BlobItem[]) {
    db.transaction(() => {
      for (const item of items) {
        const path = blobPath(item.name);
        if (!path || !item.etag || !Number.isSafeInteger(item.size) || item.size < 0) continue;
        blobUpsert.run(
          target.source_key,
          target.container,
          item.name,
          path.resourceId,
          path.prefix,
          path.time,
          item.etag,
          item.size,
          item.blobType,
          item.createdOn,
        );
      }
    }).immediate();
  }
  function pending(source: string, containers: string[], now: string, limit: number) {
    const base = `SELECT * FROM import_blobs WHERE source_key = ? AND complete = 0
      AND container IN (${containers.map(() => '?').join(',')}) AND (retry_at IS NULL OR retry_at <= ?)
      ORDER BY CASE WHEN EXISTS (SELECT 1 FROM import_issues i WHERE i.source_key = import_blobs.source_key AND i.container = import_blobs.container AND i.blob_name = import_blobs.name) THEN 0 ELSE 1 END, failures, blob_time`;
    const oldCount = limit > 1 ? Math.max(1, Math.floor(limit / 4)) : 0;
    const recent = db
      .prepare(`${base} DESC, name LIMIT ?`)
      .all(source, ...containers, now, limit - oldCount) as BlobRow[];
    const oldest = oldCount
      ? (db
          .prepare(`${base} ASC, name LIMIT ?`)
          .all(source, ...containers, now, limit) as BlobRow[])
      : [];
    const seen = new Set(recent.map((x) => `${x.container}/${x.name}`));
    return [...recent, ...oldest.filter((x) => !seen.has(`${x.container}/${x.name}`))].slice(
      0,
      limit,
    );
  }
  function failBlob(blob: BlobRow, now: Date, message: string) {
    const retry = new Date(
      now.getTime() + Math.min(3600000, 30000 * 2 ** Math.min(blob.failures, 7)),
    ).toISOString();
    db.prepare(
      'UPDATE import_blobs SET failures = failures + 1, retry_at = ?, error = ? WHERE source_key = ? AND container = ? AND name = ?',
    ).run(retry, message, blob.source_key, blob.container, blob.name);
  }
  function commitChunk(
    blob: BlobRow,
    rows: { offset: number; item: ParsedRecord }[],
    issues: { offset: number; hash: string; reason: string }[],
    offset: number,
    complete: boolean,
  ) {
    return db
      .transaction(() => {
        let imported = 0;
        const start = rows.length
          ? Math.min(...rows.map((row) => row.offset), ...issues.map((issue) => issue.offset))
          : issues.length
            ? Math.min(...issues.map((issue) => issue.offset))
            : offset;
        // Row and issue offsets all fall inside this range.
        issueRangeDelete.run(blob.source_key, blob.container, blob.name, start, offset);
        for (const row of rows) imported += storeRecord(blob, row.offset, row.item);
        if (imported) database.markCostsDirty();
        for (const issue of issues)
          issueInsert.run(
            blob.source_key,
            blob.container,
            blob.name,
            issue.offset,
            issue.hash,
            issue.reason,
          );
        checkpointUpdate.run(
          blob.etag,
          blob.created_on,
          offset,
          complete ? 1 : 0,
          blob.source_key,
          blob.container,
          blob.name,
        );
        return imported;
      })
      .immediate();
  }
  function counts(source: string, containers: string[]) {
    const count = (sql: string) => (db.prepare(sql).get(source) as { n: number }).n;
    const blobs = db
      .prepare(
        `SELECT count(*) AS n FROM import_blobs WHERE source_key = ? AND complete = 0 AND container IN (${containers.map(() => '?').join(',') || "''"})`,
      )
      .get(source, ...containers) as { n: number };
    return {
      requestCount: count(
        'SELECT count(*) AS n FROM request_facts WHERE source_key = ? AND is_inference = 1',
      ),
      resourceCount: count(
        'SELECT count(DISTINCT resource_id) AS n FROM import_blobs WHERE source_key = ?',
      ),
      issueCount: count('SELECT count(*) AS n FROM import_issues WHERE source_key = ?'),
      pendingBlobs: blobs.n,
      pendingScans: count(
        'SELECT count(*) n FROM review_progress WHERE source_key=? AND active_until IS NOT NULL',
      ),
    };
  }
  function saveRun(source: string, run: ImportRun) {
    db.prepare(
      `INSERT INTO import_runs (id,source_key,mode,started_at,finished_at,status,imported_records,downloaded_bytes,list_calls,read_calls,error_count,message,trigger,actor) VALUES (@id, @source, @mode, @startedAt, @finishedAt, @status, @importedRecords, @downloadedBytes, @listCalls, @readCalls, @errorCount, @message, @trigger, @actor)
      ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status,
        imported_records = excluded.imported_records, downloaded_bytes = excluded.downloaded_bytes,
        list_calls = excluded.list_calls, read_calls = excluded.read_calls, error_count = excluded.error_count, message = excluded.message`,
    ).run({ ...run, source, trigger: run.trigger ?? null, actor: run.actor ?? null });
  }
  function runs(source: string): ImportRun[] {
    const current = db
      .prepare(
        `SELECT id,mode,trigger,actor,started_at startedAt,finished_at finishedAt,status,imported_records importedRecords,downloaded_bytes downloadedBytes,list_calls listCalls,read_calls readCalls,error_count errorCount,message FROM import_runs WHERE source_key=? ORDER BY started_at DESC LIMIT 10`,
      )
      .all(source) as ImportRun[];
    const history = database.logs.query({
      category: 'task',
      sourceKey: source,
      limit: 10,
      offset: 0,
    }).logs as StoredLog[];
    const seen = new Map(current.map((run) => [run.id, run]));
    for (const entry of history)
      if (entry.run && !seen.has(entry.id)) seen.set(entry.id, entry.run);
    return [...seen.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
  }
  return {
    savePage,
    changed(source: string, container: string, item: BlobItem) {
      const row = db
        .prepare('SELECT etag FROM import_blobs WHERE source_key=? AND container=? AND name=?')
        .get(source, container, item.name) as { etag: string } | undefined;
      return !row || row.etag !== item.etag;
    },
    pending,
    failBlob,
    commitChunk,
    counts,
    saveRun,
    runs,
    evidence(source: string, resourceId: string, correlationId: string): RecordEvidence[] {
      const rows = db
        .prepare(
          `SELECT category,container,blob_name AS blobName,byte_offset AS byteOffset,hash,source_key AS sourceKey,raw_json AS raw
        FROM diagnostic_records WHERE source_key=? AND resource_id=? AND correlation_id=? ORDER BY category,time,hash`,
        )
        .all(source, resourceId.toLowerCase(), correlationId) as RecordEvidence[];
      return rows.map((row) => {
        const data = parseJson(row.raw!) as Record<string, unknown>;
        if (typeof data.properties === 'string') {
          try {
            data.properties = parseJson(data.properties);
          } catch {
            /* Preserve malformed properties verbatim. */
          }
        }
        const locations = db
          .prepare(
            'SELECT container,blob_name AS blobName,byte_offset AS byteOffset FROM record_locations WHERE source_key=? AND hash=? ORDER BY blob_name,byte_offset',
          )
          .all(source, row.hash) as NonNullable<RecordEvidence['locations']>;
        return { ...row, data, locations };
      });
    },
    issues(source: string, containers: string[]): IngestionStatus['issues'] {
      return db
        .prepare(
          `SELECT container, blob_name AS blobName, byte_offset AS byteOffset, reason FROM import_issues WHERE source_key = ?
        UNION ALL SELECT container, name AS blobName, byte_offset AS byteOffset, error AS reason FROM import_blobs WHERE source_key = ? AND error IS NOT NULL
          AND container IN (${containers.map(() => '?').join(',') || "''"}) LIMIT 5`,
        )
        .all(source, source, ...containers) as IngestionStatus['issues'];
    },
    recover() {
      db.prepare(
        "UPDATE import_runs SET status = 'interrupted', finished_at = ?, message = '服务重启，已提交的断点保留。' WHERE status = 'running'",
      ).run(new Date().toISOString());
    },
    retry(source: string) {
      db.prepare(
        'UPDATE import_blobs SET retry_at = NULL WHERE source_key = ? AND complete = 0',
      ).run(source);
    },
  };
}
export type ImportRepository = ReturnType<typeof createImportRepository>;
