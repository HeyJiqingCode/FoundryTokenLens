import { createReviewProgress } from './review-progress.js';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from '../settings/repository.js';
import { LOG_CONTAINERS, type SourceSettings } from '../../shared/settings.js';
import type { ImportRun, IngestionStatus, RunMode } from '../../shared/ingestion.js';
import { HttpError } from '../http/errors.js';
import { azureBlobReader, type BlobReaderFactory, type BlobReader } from './blob-reader.js';
import { createImportRepository, type BlobRow } from './repository.js';
import { hash, parseRecord, sourceKey, type ParsedRecord } from './parser.js';
import { dueTaskSlot } from './schedule.js';
import type { ScheduledTask } from '../../shared/scheduled-tasks.js';

const CHUNK_BYTES = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const revision = (source: SourceSettings) => JSON.stringify([source.updatedAt, source.containers]);
const safeError = (error: unknown) => {
  const code = (error as { statusCode?: number }).statusCode;
  if (code === 401 || code === 403) return 'Blob 访问被拒绝，请检查凭据、权限与网络规则。';
  if (code === 404) return '日志文件或容器已不存在，下次扫描会重试。';
  if (code === 412 || code === 416) return '日志读取期间发生变化，下次扫描会重试。';
  return '日志读取未完成，请检查数据源连接；已保存的进度不会丢失。';
};

export function createImportWorker(
  database: AppDatabase,
  settings: SettingsRepository,
  readerFactory: BlobReaderFactory = azureBlobReader,
  clock: () => Date = () => new Date(),
  refreshStatistics?: (id: string, signal: AbortSignal, onList: () => void) => Promise<unknown>,
  flushLogs?: () => void,
) {
  const db = database.connection;
  const repository = createImportRepository(database);
  const reviews = createReviewProgress(database, repository);
  const pendingDelete = db.prepare(
    'DELETE FROM task_pending WHERE task_id=? AND slot=? AND source_id=?',
  );
  const pendingExists = db.prepare('SELECT 1 FROM task_pending WHERE task_id=? AND source_id=?');
  const pendingInsert = db.prepare('INSERT OR IGNORE INTO task_pending VALUES (?,?,?,?,?)');
  repository.recover();
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | null = null;
  let activeRun: ImportRun | null = null;
  let controller: AbortController | null = null;
  let stopping = false;
  let resetting = false;
  let wakeAt = 0;
  let workerError: string | null = null;
  let activePolicy: string | null = null;
  const policy = (source: SourceSettings) => {
    return JSON.stringify(
      settings.tasksForSource(source.id).map((task) => [task.id, task.updatedAt]),
    );
  };
  function workerFailed() {
    workerError = '处理器暂时无法完成任务，请检查平台持久存储是否可读写。';
    wakeAt = clock().getTime() + 60000;
  }

  function ensureCurrent(source: SourceSettings, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = settings.getSources().find((item) => item.id === source.id);
    if (
      !current?.enabled ||
      revision(current) !== revision(source) ||
      (activePolicy !== null && policy(current) !== activePolicy)
    )
      throw new Error('SourceChanged');
  }

  function reviewTask(source: SourceSettings) {
    return settings.tasksForSource(source.id).find((task) => task.type === 'review');
  }
  function reviewId(source: SourceSettings) {
    return reviewTask(source)?.id ?? 'manual';
  }
  function reviewStatus(source: SourceSettings) {
    return reviews.summary(reviewId(source), source);
  }
  async function readBlob(
    source: SourceSettings,
    reader: BlobReader,
    blob: BlobRow,
    run: ImportRun,
    signal: AbortSignal,
  ) {
    const sameGeneration =
      blob.created_on !== null && blob.created_on === blob.checkpoint_created_on;
    // Resuming across ETags is safe only for the same append-blob generation.
    let offset =
      blob.checkpoint_etag === blob.etag ||
      (blob.blob_type === 'AppendBlob' && sameGeneration && blob.size >= blob.byte_offset)
        ? blob.byte_offset
        : 0;
    if (offset > blob.size) offset = 0;
    const count = Math.min(CHUNK_BYTES, blob.size - offset);
    if (count <= 0 && offset < blob.size) return;
    if (count) run.readCalls++;
    const bytes = count
      ? await reader.read(blob.container, blob.name, offset, count, blob.etag, signal)
      : Buffer.alloc(0);
    if (bytes.length !== count) throw new Error('IncompleteDownload');
    run.downloadedBytes += bytes.length;
    ensureCurrent(source, signal);
    const atEnd = offset + bytes.length === blob.size;
    const category = LOG_CONTAINERS.find((x) => x.name === blob.container)!.category;
    let consumed = 0;
    let tailPending = false;
    const rows: { offset: number; item: ParsedRecord }[] = [];
    const issues: { offset: number; hash: string; reason: string }[] = [];
    while (consumed < bytes.length) {
      const newline = bytes.indexOf(10, consumed);
      if (newline < 0 && !atEnd) break;
      const end = newline < 0 ? bytes.length : newline;
      const line = bytes.subarray(consumed, end);
      try {
        const value = decoder.decode(line).trim();
        if (value)
          for (const item of parseRecord(value, category, blob.resource_id))
            rows.push({ offset: offset + consumed, item });
      } catch {
        if (newline < 0) {
          tailPending = true;
          break;
        }
        issues.push({
          offset: offset + consumed,
          hash: hash(line),
          reason: '该行无法解析或缺少必要字段，已隔离；请检查原始日志。',
        });
      }
      consumed = newline < 0 ? bytes.length : newline + 1;
    }
    ensureCurrent(source, signal);
    const complete = offset + consumed === blob.size && !tailPending;
    if (consumed > 0 || complete)
      run.importedRecords += repository.commitChunk(
        blob,
        rows,
        issues,
        offset + consumed,
        complete,
      );
    if (issues.length) {
      run.errorCount += issues.length;
      run.message = '部分日志行无法解析，已保留来源位置；其余有效记录继续导入。';
    }
    if (tailPending || (count > 0 && consumed === 0)) {
      repository.failBlob(blob, clock(), '文件末行不完整或单行超过 8 MiB，保留断点等待重试。');
      run.errorCount++;
      run.message = '部分文件末行尚未完整或单行过大，已保留断点等待重试。';
    }
  }

  async function execute(source: SourceSettings, run: ImportRun, signal: AbortSignal) {
    const key = sourceKey(source);
    activePolicy = policy(source);
    const now = clock();
    repository.saveRun(key, run);
    try {
      const reader = readerFactory(
        settings.resolveSource(
          {
            ...source,
            useSavedCredential: source.authMode === 'connection_string',
          },
          source.id,
        ),
      );
      ensureCurrent(source, signal);
      for (const container of LOG_CONTAINERS.filter(
        (item) => !source.containers.includes(item.name),
      )) {
        try {
          run.listCalls++;
          await reader.list(container.name, '', undefined, signal);
        } catch (error) {
          ensureCurrent(source, signal);
          if ((error as { statusCode?: number }).statusCode === 404) continue;
          run.errorCount++;
          run.message = safeError(error);
          continue;
        }
        ensureCurrent(source, signal);
        source = settings.discoverContainer(source, container.name);
      }
      // Both manual and scheduled scans share the same successful import boundary.
      // Incomplete files keep their offsets; each trigger also discovers the latest files.
      const scopes = ['ingestion'];
      if (run.mode === 'reconcile' || reviewStatus(source).active) scopes.push(reviewId(source));
      for (const scope of scopes) {
        ensureCurrent(source, signal);
        reviews.begin(scope, source, now);
        while (reviews.summary(scope, source).active) {
          await reviews.list(
            scope,
            source,
            reader,
            signal,
            () => {
              run.listCalls++;
            },
            () => ensureCurrent(source, signal),
          );
          const pending = repository.pending(key, source.containers, clock().toISOString(), 20);
          for (const blob of pending) {
            ensureCurrent(source, signal);
            try {
              await readBlob(source, reader, blob, run, signal);
            } catch (error) {
              ensureCurrent(source, signal);
              run.errorCount++;
              run.message = safeError(error);
              repository.failBlob(blob, clock(), run.message);
            }
            repository.saveRun(key, run);
          }
          ensureCurrent(source, signal);
          reviews.finish(scope, source, clock());
          const unfinishedListing = source.containers.some((container) => {
            const checkpoint = reviews.get(scope, key, container);
            return checkpoint.activeUntil && !checkpoint.listingDone;
          });
          if (!unfinishedListing && !pending.length && reviews.summary(scope, source).active) {
            run.errorCount++;
            run.message ??= '尚有未完成日志，保留断点等待下次任务。';
            break;
          }
        }
      }
      run.status = run.errorCount ? 'partial' : 'succeeded';
    } catch (error) {
      const changed =
        signal.aborted ||
        settings.getSources().find((item) => item.id === source.id)?.updatedAt !==
          source.updatedAt ||
        policy(source) !== activePolicy;
      run.status = changed ? 'interrupted' : 'failed';
      run.errorCount++;
      run.message = changed ? '任务已停止；已提交的记录和断点保留。' : safeError(error);
    } finally {
      if (!signal.aborted && run.status !== 'interrupted' && refreshStatistics) {
        try {
          ensureCurrent(source, signal);
          await refreshStatistics(source.id, signal, () => {
            run.listCalls++;
          });
        } catch {
          if (!signal.aborted) {
            if (run.status === 'succeeded') run.status = 'partial';
            run.errorCount++;
            run.message = run.message ?? '文件统计更新失败，保留上次统计结果。';
          }
        }
      }
      run.finishedAt = clock().toISOString();
      repository.saveRun(key, run);
      try {
        flushLogs?.();
      } catch {
        workerError = '系统日志写入失败，待写记录已保留。';
      }
      wakeAt = clock().getTime() + (run.errorCount ? 60000 : 5000);
    }
  }

  function request(
    mode: RunMode,
    manual = true,
    selected?: SourceSettings[],
    plans = new Map<string, { task: ScheduledTask; slot: string }[]>(),
    actor?: string,
  ) {
    if (resetting) throw new HttpError(409, 'schedule.resetInProgress');
    if (stopping) throw new HttpError(503, 'ingestion.serviceIsStopping');
    const sources = selected ?? settings.getSources().filter((source) => source.enabled);
    if (!sources.length) throw new HttpError(409, 'ingestion.configureADataSourceFirst');
    if (active && activeRun) return { runId: activeRun.id, coalesced: true };
    const createRun = (): ImportRun => ({
      id: randomUUID(),
      mode,
      trigger: manual ? 'manual' : 'scheduled',
      actor: manual ? (actor ?? null) : 'Scheduler',
      startedAt: clock().toISOString(),
      finishedAt: null,
      status: 'running',
      importedRecords: 0,
      downloadedBytes: 0,
      listCalls: 0,
      readCalls: 0,
      errorCount: 0,
      message: null,
    });
    const first = createRun();
    activeRun = first;
    workerError = null;
    controller = new AbortController();
    active = (async () => {
      for (const [index, source] of sources.entries()) {
        if (controller!.signal.aborted) break;
        const run = index === 0 ? first : createRun();
        activeRun = run;
        const due = plans.get(source.id) ?? [];
        if (due.some((item) => item.task.type === 'review')) run.mode = 'reconcile';
        for (const item of due) {
          reviews.record(item.task, item.slot, new Date(run.startedAt));
          pendingDelete.run(item.task.id, item.slot, source.id);
        }
        repository.retry(sourceKey(source));
        await execute(source, run, controller!.signal);
      }
    })()
      .catch(workerFailed)
      .finally(() => {
        active = null;
        activeRun = null;
        activePolicy = null;
        controller = null;
      });
    return { runId: first.id, coalesced: false };
  }

  function collectDue(now: Date) {
    const prior = db.prepare('SELECT checked_at FROM scheduler_state WHERE id=1').get() as
      { checked_at: string } | undefined;
    const end = Math.floor(now.getTime() / 60000) * 60000;
    if (prior && Math.floor(Date.parse(prior.checked_at) / 60000) * 60000 === end) return;
    const start = prior
      ? Math.min(end, Math.floor(Date.parse(prior.checked_at) / 60000) * 60000 + 60000)
      : end;
    const sources = settings.getSources();
    db.transaction(() => {
      for (const source of sources) {
        if (!source.enabled) continue;
        const completedAt = reviewStatus(source).completedAt;
        for (const task of settings.tasksForSource(source.id)) {
          const changed = Math.max(
            Date.parse(source.updatedAt) || 0,
            Date.parse(task.updatedAt) || 0,
          );
          for (let minute = start; minute <= end; minute += 60000) {
            if (task.type === 'daily' && minute !== end) continue;
            if (changed <= now.getTime() && changed >= minute) continue;
            const slot = dueTaskSlot(task, new Date(minute), completedAt);
            if (!slot || reviews.hasExecution(task.id, slot)) continue;
            // One outstanding occurrence per task/source: the next run covers the whole gap.
            if (!pendingExists.get(task.id, source.id))
              pendingInsert.run(
                task.id,
                slot,
                source.id,
                new Date(minute).toISOString(),
                task.updatedAt,
              );
          }
        }
      }
      db.prepare(
        'INSERT INTO scheduler_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at',
      ).run(now.toISOString());
    })();
  }
  async function tick() {
    if (stopping || resetting) return;
    const now = clock();
    collectDue(now);
    if (active || now.getTime() < wakeAt) return;
    const plans = new Map<string, { task: ScheduledTask; slot: string }[]>();
    const rows = db
      .prepare('SELECT task_id,slot,source_id,task_revision FROM task_pending ORDER BY due_at')
      .all() as { task_id: string; slot: string; source_id: string; task_revision: string }[];
    const sources = settings.getSources();
    for (const row of rows) {
      const source = sources.find((source) => source.id === row.source_id && source.enabled);
      const task = source
        ? settings
            .tasksForSource(source.id)
            .find((task) => task.id === row.task_id && task.updatedAt === row.task_revision)
        : undefined;
      if (!source || !task) {
        pendingDelete.run(row.task_id, row.slot, row.source_id);
        continue;
      }
      const items = plans.get(source.id) ?? [];
      items.push({ task, slot: row.slot });
      plans.set(source.id, items);
    }
    const due = sources.filter((source) => plans.has(source.id));
    if (due.length) {
      request('scan', false, due, plans);
      await active;
    }
  }

  function status(): IngestionStatus {
    const sources = settings.getSources().filter((source) => source.enabled);
    const totals = sources.map((source) => ({
      source,
      key: sourceKey(source),
      counts: repository.counts(sourceKey(source), source.containers),
    }));
    const counts = {
      requestCount: 0,
      resourceCount: 0,
      issueCount: totals.reduce((sum, item) => sum + item.counts.issueCount, 0),
      pendingBlobs: totals.reduce((sum, item) => sum + item.counts.pendingBlobs, 0),
      pendingScans: totals.reduce((sum, item) => sum + item.counts.pendingScans, 0),
    };
    const keys = totals.map((item) => item.key);
    if (keys.length === 1) {
      counts.requestCount = totals[0].counts.requestCount;
      counts.resourceCount = totals[0].counts.resourceCount;
    } else if (keys.length > 1) {
      const placeholders = keys.map(() => '?').join(',');
      counts.requestCount = (
        database.connection
          .prepare(
            `SELECT count(*) n FROM (SELECT 1 FROM request_facts WHERE source_key IN (${placeholders}) AND is_inference=1 GROUP BY resource_id,correlation_id)`,
          )
          .get(...keys) as { n: number }
      ).n;
      counts.resourceCount = (
        database.connection
          .prepare(
            `SELECT count(DISTINCT resource_id) n FROM import_blobs WHERE source_key IN (${placeholders})`,
          )
          .get(...keys) as { n: number }
      ).n;
    }
    return {
      dataRevision: JSON.stringify([database.instanceId, database.dataRevision(), keys]),
      configured: sources.length > 0,
      running: !!active,
      ...counts,
      workerError,
      issues: totals
        .flatMap(({ source, key }) => repository.issues(key, source.containers))
        .slice(0, 5),
      runs: totals
        .flatMap(({ key }) => repository.runs(key))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, 10),
    };
  }

  async function maintenance<T>(action: () => T): Promise<T> {
    if (resetting) throw new HttpError(409, 'schedule.resetInProgress');
    resetting = true;
    try {
      controller?.abort();
      await active;
      const result = action();
      workerError = null;
      wakeAt = 0;
      return result;
    } finally {
      resetting = false;
    }
  }

  return {
    async clearLogData(actor: string) {
      await maintenance(() => settings.clearLogData(actor));
    },
    async resetHistory(actor: string) {
      return maintenance(() => settings.resetTaskHistory(actor));
    },
    request,
    tick,
    status,
    get running() {
      return active !== null;
    },
    evidence(resourceId: string, correlationId: string) {
      return settings
        .getSources()
        .filter((source) => source.enabled)
        .flatMap((source) =>
          repository
            .evidence(sourceKey(source), resourceId, correlationId)
            .map((record) => ({ ...record, sourceName: source.accountName })),
        );
    },
    async settled() {
      await active;
    },
    start() {
      timer = setInterval(() => {
        void tick().catch(workerFailed);
      }, 1000);
      timer.unref();
      void tick().catch(workerFailed);
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      controller?.abort();
      await active;
    },
  };
}

export type ImportWorker = ReturnType<typeof createImportWorker>;
