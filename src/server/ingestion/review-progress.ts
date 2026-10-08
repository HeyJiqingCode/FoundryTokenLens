import type { AppDatabase } from '../database.js';
import type { SourceSettings } from '../../shared/settings.js';
import type { ScheduledTask } from '../../shared/scheduled-tasks.js';
import type { BlobReader } from './blob-reader.js';
import { blobPath, sourceKey } from './parser.js';
import { createImportRepository, type ImportRepository } from './repository.js';

interface ReviewCheckpoint {
  lastSuccessAt: string | null;
  completedAt: string | null;
  activeUntil: string | null;
  activeFrom: string | null;
  marker: string | null;
  listingDone: number;
}
export function createReviewProgress(
  database: AppDatabase,
  imports: ImportRepository = createImportRepository(database),
) {
  const db = database.connection;
  function get(taskId: string, sourceKey: string, container: string): ReviewCheckpoint {
    return (
      (db
        .prepare(
          `SELECT last_success_at lastSuccessAt, completed_at completedAt, active_until activeUntil, active_from activeFrom, marker, listing_done listingDone FROM review_progress WHERE task_id=? AND source_key=? AND container=?`,
        )
        .get(taskId, sourceKey, container) as ReviewCheckpoint) ?? {
        lastSuccessAt: null,
        completedAt: null,
        activeUntil: null,
        activeFrom: null,
        marker: null,
        listingDone: 0,
      }
    );
  }
  function summary(taskId: string, source: SourceSettings) {
    const key = sourceKey(source);
    const states = source.containers.map((container) => get(taskId, key, container));
    return {
      active: states.some((s) => s.activeUntil),
      completedAt: states.every((s) => s.completedAt)
        ? states.map((s) => s.completedAt!).sort()[0]
        : null,
    };
  }
  function begin(taskId: string, source: SourceSettings, now: Date) {
    const key = sourceKey(source);
    db.transaction(() => {
      for (const container of source.containers) {
        const old = get(taskId, key, container);
        if (old.activeUntil) {
          // Keep the unresolved lower boundary, but discover files through this run's time.
          // A new upper boundary requires a fresh listing; committed file offsets are retained.
          const until = old.activeUntil > now.toISOString() ? old.activeUntil : now.toISOString();
          const relist = until !== old.activeUntil || old.listingDone === 1;
          db.prepare(
            'UPDATE review_progress SET active_until=?,marker=?,listing_done=0 WHERE task_id=? AND source_key=? AND container=?',
          ).run(until, relist ? null : old.marker, taskId, key, container);
          continue;
        }
        db.prepare(
          `INSERT INTO review_progress (task_id,source_key,container,last_success_at,completed_at,active_until,active_from,marker,listing_done) VALUES (?,?,?,?,?,?,?,NULL,0)
          ON CONFLICT(task_id,source_key,container) DO UPDATE SET active_until=excluded.active_until,active_from=excluded.active_from,marker=NULL,listing_done=0`,
        ).run(
          taskId,
          key,
          container,
          old.lastSuccessAt,
          old.completedAt,
          now.toISOString(),
          old.lastSuccessAt,
        );
        db.prepare('DELETE FROM review_files WHERE task_id=? AND source_key=? AND container=?').run(
          taskId,
          key,
          container,
        );
      }
    }).immediate();
  }
  async function list(
    taskId: string,
    source: SourceSettings,
    reader: BlobReader,
    signal: AbortSignal,
    onList: () => void,
    ensureCurrent: () => void,
  ) {
    const key = sourceKey(source);
    for (const container of source.containers) {
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const state = get(taskId, key, container);
        if (!state.activeUntil || state.listingDone) break;
        signal.throwIfAborted();
        onList();
        const page = await reader.list(container, '', state.marker ?? undefined, signal);
        ensureCurrent();
        const from = state.activeFrom
          ? new Date(Math.floor(Date.parse(state.activeFrom) / 3600000) * 3600000).toISOString()
          : null;
        const items = page.items.filter((item) => {
          const path = blobPath(item.name);
          return (
            path &&
            path.time <= state.activeUntil! &&
            (!from || path.time >= from || imports.changed(key, container, item))
          );
        });
        db.transaction(() => {
          imports.savePage({ source_key: key, container }, items);
          for (const item of items)
            db.prepare('INSERT OR REPLACE INTO review_files VALUES (?,?,?,?,?)').run(
              taskId,
              key,
              container,
              item.name,
              item.size,
            );
          db.prepare(
            'UPDATE review_progress SET marker=?, listing_done=? WHERE task_id=? AND source_key=? AND container=?',
          ).run(page.marker, page.marker ? 0 : 1, taskId, key, container);
        }).immediate();
      }
    }
  }
  function finish(taskId: string, source: SourceSettings, now: Date) {
    const key = sourceKey(source);
    db.transaction(() => {
      for (const container of source.containers) {
        const state = get(taskId, key, container);
        if (!state.activeUntil || !state.listingDone) continue;
        const pending = db
          .prepare(
            `SELECT 1 FROM review_files f LEFT JOIN import_blobs b ON b.source_key=f.source_key AND b.container=f.container AND b.name=f.name
          WHERE f.task_id=? AND f.source_key=? AND f.container=? AND (b.name IS NULL OR b.byte_offset<f.required_size OR b.checkpoint_etag IS NOT b.etag) LIMIT 1`,
          )
          .get(taskId, key, container);
        if (pending) continue;
        db.prepare(
          `UPDATE review_progress SET last_success_at=active_until,completed_at=?,active_until=NULL,active_from=NULL,marker=NULL,listing_done=0 WHERE task_id=? AND source_key=? AND container=?`,
        ).run(now.toISOString(), taskId, key, container);
        db.prepare('DELETE FROM review_files WHERE task_id=? AND source_key=? AND container=?').run(
          taskId,
          key,
          container,
        );
      }
    }).immediate();
  }
  function record(task: ScheduledTask, slot: string, now: Date) {
    db.prepare('INSERT OR IGNORE INTO task_executions VALUES (?,?,?)').run(
      task.id,
      slot,
      now.toISOString(),
    );
  }
  function hasExecution(taskId: string, slot: string) {
    return Boolean(
      db.prepare('SELECT 1 FROM task_executions WHERE task_id=? AND slot=?').get(taskId, slot),
    );
  }
  return { get, summary, begin, list, finish, record, hasExecution };
}
