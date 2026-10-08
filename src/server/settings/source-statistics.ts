import type { SourceStatistics } from '../../shared/source-statistics.js';
import type { SourceSettings } from '../../shared/settings.js';
import type { AppDatabase } from '../database.js';
import type { SettingsRepository } from './repository.js';
import { azureBlobReader, type BlobReaderFactory } from '../ingestion/blob-reader.js';
import { HttpError } from '../http/errors.js';

const scope = (source: SourceSettings) =>
  JSON.stringify([source.endpoint, [...source.containers].sort()]);

export function createSourceStatistics(
  database: AppDatabase,
  settings: SettingsRepository,
  readerFactory: BlobReaderFactory = azureBlobReader,
  now: () => number = Date.now,
) {
  const active = new Map<string, { revision: string; result: Promise<SourceStatistics> }>();
  const shutdown = new AbortController();
  function findSource(id: string) {
    const source = settings.getSources().find((source) => source.id === id);
    if (!source) throw new HttpError(404, 'sources.sourceNotFound');
    return source;
  }
  function read(id: string): SourceStatistics | null {
    const source = findSource(id);
    return (
      (database.connection
        .prepare(
          `SELECT files, bytes, checked_at AS checkedAt
      FROM source_statistics WHERE source_id = ? AND scope = ?`,
        )
        .get(id, scope(source)) as SourceStatistics | undefined) ?? null
    );
  }
  function refresh(
    id: string,
    signal?: AbortSignal,
    onList?: () => void,
  ): Promise<SourceStatistics> {
    const source = findSource(id);
    const revision = JSON.stringify([scope(source), source.updatedAt]);
    const previous = active.get(id);
    if (previous) {
      if (previous.revision === revision) return previous.result;
      return previous.result.catch(() => undefined).then(() => refresh(id, signal, onList));
    }
    const result = Promise.resolve().then(async () => {
      try {
        const reader = readerFactory(
          settings.resolveSource(
            {
              authMode: source.authMode,
              endpoint: source.endpoint,
              managedIdentityClientId: source.managedIdentityClientId,
              useSavedCredential: source.authMode === 'connection_string',
              containers: source.containers,
            },
            id,
          ),
        );
        const abort = AbortSignal.any([
          shutdown.signal,
          AbortSignal.timeout(120000),
          ...(signal ? [signal] : []),
        ]);
        let files = 0;
        let bytes = 0n;
        for (const container of source.containers) {
          let marker: string | undefined;
          do {
            abort.throwIfAborted();
            onList?.();
            const page = await reader.list(container, '', marker, abort);
            for (const blob of page.items) {
              files += 1;
              bytes += BigInt(blob.size);
            }
            marker = page.marker ?? undefined;
          } while (marker);
        }
        abort.throwIfAborted();
        const current = findSource(id);
        if (current.updatedAt !== source.updatedAt || scope(current) !== scope(source))
          throw new Error('SourceChanged');
        const value = { files, bytes: String(bytes), checkedAt: new Date(now()).toISOString() };
        database.connection
          .prepare(
            `INSERT INTO source_statistics (source_id, scope, files, bytes, checked_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET
          scope=excluded.scope, files=excluded.files, bytes=excluded.bytes, checked_at=excluded.checked_at`,
          )
          .run(id, scope(source), value.files, value.bytes, value.checkedAt);
        return value;
      } catch {
        throw new HttpError(502, 'sources.statisticsFailed');
      } finally {
        active.delete(id);
      }
    });
    active.set(id, { revision, result });
    return result;
  }
  return {
    read,
    refresh,
    async stop() {
      shutdown.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.result));
    },
  };
}
export type SourceStatisticsService = ReturnType<typeof createSourceStatistics>;
