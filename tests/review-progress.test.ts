import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/server/database.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createReviewProgress } from '../src/server/ingestion/review-progress.js';
import { hash } from '../src/server/ingestion/parser.js';
import { taskDefaults, dailyIntervalError } from '../src/shared/scheduled-tasks.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { dueTaskSlot } from '../src/server/ingestion/schedule.js';
import { SyntheticBlobReader, path, usage } from './fixtures/diagnostics.js';

test('review preserves progress and checks new-window files plus older files whose ETag changed', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-review-progress-'));
  let db = openDatabase(directory);
  let settings = createSettingsRepository(db, createSecretStore(directory));
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://review.blob.core.windows.net',
      accountName: 'review',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  const task = settings.saveTask(
    { ...taskDefaults('review'), name: 'Review', sourceIds: [source.id], frequencyDays: 2 },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.pageSize = 1;
  reader.failRead = true;
  for (let i = 1; i <= 8; i++)
    reader.put(LOG_CONTAINERS[0].name, path('02', String(i).padStart(2, '0')), [usage(`old-${i}`)]);
  let time = new Date('2026-09-19T22:00:00Z');
  let worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => time,
  );
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await worker.tick();
  let checkpoint = createReviewProgress(db).get(
    'ingestion',
    hash(source.endpoint),
    source.containers[0],
  );
  assert.equal(checkpoint.lastSuccessAt, null);
  assert.equal(checkpoint.marker, null);
  assert.equal(checkpoint.listingDone, 1);
  assert.equal(reader.reads.length, 8);
  assert.equal(settings.listTasks()[0].executionCount, 1);
  await worker.stop();
  db.close();
  db = openDatabase(directory);
  settings = createSettingsRepository(db, createSecretStore(directory));
  worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => time,
  );
  reader.failRead = false;
  const before = reader.listings.length;
  time = new Date('2026-09-19T22:02:00Z');
  await worker.tick();
  assert.equal(reader.listings.length, before);
  time = new Date('2026-09-20T22:00:00Z');
  await worker.tick();
  assert.equal(reader.listings[before].marker, undefined);
  assert.equal(worker.status().requestCount, 8);
  checkpoint = createReviewProgress(db).get(task.id, hash(source.endpoint), source.containers[0]);
  assert.equal(checkpoint.lastSuccessAt, '2026-09-20T22:00:00.000Z');
  assert.equal(checkpoint.activeUntil, null);
  assert.equal(settings.listTasks()[0].executionCount, 2);
  const completed = checkpoint.completedAt!;
  const lists = reader.listings.length;
  time = new Date('2026-09-21T22:00:00Z');
  await worker.tick();
  assert.equal(reader.listings.length, lists);
  reader.put(LOG_CONTAINERS[0].name, path('02', '01'), [usage('old-changed')]);
  reader.put(LOG_CONTAINERS[0].name, path('02', '22'), [usage('new')]);
  time = new Date('2026-09-22T22:00:00Z');
  const readStart = reader.reads.length;
  await worker.tick();
  assert.deepEqual(
    new Set(reader.reads.slice(readStart).map((read) => read.name)),
    new Set([path('02', '01'), path('02', '22')]),
  );
  assert.equal(
    createReviewProgress(db).get(task.id, hash(source.endpoint), source.containers[0])
      .lastSuccessAt,
    '2026-09-22T22:00:00.000Z',
  );
  assert.equal(settings.listTasks()[0].executionCount, 3);
  assert.equal(dueTaskSlot(task, new Date('2026-09-21T00:00:00Z'), completed), null);
  settings.saveTask({ ...task, name: 'Renamed' }, 'test', task.id);
  assert.equal(
    createReviewProgress(db).get(task.id, hash(source.endpoint), source.containers[0])
      .lastSuccessAt,
    '2026-09-22T22:00:00.000Z',
  );
});

test('intervals must divide both day and overnight periods', () => {
  const defaults = taskDefaults('daily');
  if (defaults.type !== 'daily') throw Error('daily');
  assert.equal(
    dailyIntervalError({
      ...defaults,
      daytime: { startTime: '18:00', endTime: '21:00', intervalMinutes: 120 },
    }),
    'schedule.intervalDoesNotFit',
  );
  assert.equal(
    dailyIntervalError({
      ...defaults,
      daytime: { startTime: '18:00', endTime: '21:00', intervalMinutes: 60 },
    }),
    null,
  );
  assert.equal(
    dailyIntervalError({
      ...defaults,
      daytime: { startTime: '18:00', endTime: '21:00', intervalMinutes: 180 },
    }),
    null,
  );
  assert.equal(
    dailyIntervalError({ ...defaults, nighttime: { intervalMinutes: 180 } }),
    'schedule.intervalDoesNotFit',
  );
});
