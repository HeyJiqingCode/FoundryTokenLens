import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import {
  taskDefaults,
  taskConflict,
  setDailyBoundary,
  type ScheduledTask,
} from '../src/shared/scheduled-tasks.js';
import { dueTaskSlot } from '../src/server/ingestion/schedule.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { SyntheticBlobReader, path, usage } from './fixtures/diagnostics.js';
import { testApp, requestHeaders } from './helpers.js';

test('tasks persist, apply independent schedules, prevent conflicting sources, and stop when disabled or deleted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-tasks-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const readers = new Map<string, SyntheticBlobReader>();
  function addSource(name: string) {
    readers.set(name, new SyntheticBlobReader());
    return settings.saveSource(
      { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
      {
        authMode: 'connection_string',
        connectionString: name,
        endpoint: '',
        managedIdentityClientId: '',
      },
      {
        endpoint: `https://${name}.blob.core.windows.net`,
        accountName: name,
        containers: [...LOG_CONTAINERS],
        verifiedAt: new Date().toISOString(),
      },
      'test',
    );
  }
  const one = addSource('one'),
    two = addSource('two');
  const base = {
    ...taskDefaults('daily'),
    enabled: true,
    name: 'Five minutes',
    sourceIds: [one.id],
  };
  const a = settings.saveTask(base, 'test');
  const b = settings.saveTask(
    {
      ...base,
      name: 'Hourly',
      sourceIds: [two.id],
      daytime: { startTime: '06:00', endTime: '22:00', intervalMinutes: 60 },
    },
    'test',
  );
  assert.throws(() => settings.saveTask(base, 'test'), { statusCode: 409 });
  const reopened = openDatabase(directory);
  assert.equal(
    createSettingsRepository(reopened, createSecretStore(directory)).getTasks().length,
    2,
  );
  reopened.close();
  let now = new Date('2026-09-27T04:00:00Z');
  const worker = createImportWorker(
    db,
    settings,
    (source) => readers.get(source.connectionString)!,
    () => now,
  );
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await worker.tick();
  await worker.settled();
  const firstA = readers.get('one')!.listings.length,
    firstB = readers.get('two')!.listings.length;
  assert.ok(firstA > 0 && firstB > 0);
  now = new Date('2026-09-27T04:05:00Z');
  await worker.tick();
  await worker.settled();
  assert.ok(readers.get('one')!.listings.length > firstA);
  assert.equal(readers.get('two')!.listings.length, firstB);
  settings.saveTask({ ...a, enabled: false }, 'test', a.id);
  const paused = readers.get('one')!.listings.length;
  now = new Date('2026-09-27T05:00:00Z');
  await worker.tick();
  await worker.settled();
  assert.equal(readers.get('one')!.listings.length, paused);
  assert.ok(readers.get('two')!.listings.length > firstB);
  settings.deleteTask(b.id, 'test');
  const before = readers.get('two')!.listings.length;
  now = new Date('2026-09-28T05:00:00Z');
  await worker.tick();
  await worker.settled();
  assert.equal(readers.get('two')!.listings.length, before);
  settings.deleteSource(one.id, 'test');
  assert.deepEqual(settings.getTasks()[0].sourceIds, []);
  assert.equal(settings.getSources().length, 1);
});

test('task routes enforce admin access, validate configuration, and persist CRUD', async (t) => {
  const { app, cookie } = await testApp(t, {
    async inspect() {
      return {
        endpoint: 'https://test.blob.core.windows.net',
        accountName: 'test',
        containers: [...LOG_CONTAINERS],
        verifiedAt: new Date().toISOString(),
      };
    },
  });
  const headers = { ...requestHeaders, cookie };
  assert.equal((await app.inject({ method: 'GET', url: '/api/settings/tasks' })).statusCode, 401);
  const source = await app.inject({
    method: 'POST',
    url: '/api/settings/sources',
    headers,
    payload: { authMode: 'connection_string', connectionString: 'test', containers: [] },
  });
  const input = {
    ...taskDefaults('daily'),
    name: 'Task',
    enabled: true,
    sourceIds: [source.json().source.id],
  };
  const create = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/settings/tasks', headers, payload: payload as object });
  assert.equal((await create({ ...input, sourceIds: [] })).statusCode, 400);
  assert.equal((await create({ ...input, timezone: 'not/a/timezone' })).statusCode, 400);
  assert.equal(
    (
      await create({
        ...taskDefaults('review'),
        name: 'Review',
        sourceIds: input.sourceIds,
        hour: 24,
        frequencyDays: 8,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await create({
        ...input,
        daytime: { startTime: '06:00', endTime: '06:00', intervalMinutes: 5 },
      })
    ).statusCode,
    400,
  );
  const created = await create(input);
  assert.equal(created.statusCode, 201);
  assert.equal((await create(input)).statusCode, 409);
  const id = created.json().task.id;
  const toggled = await app.inject({
    method: 'PATCH',
    url: `/api/settings/tasks/${id}`,
    headers,
    payload: { enabled: false },
  });
  assert.equal(toggled.statusCode, 200);
  assert.equal(toggled.json().task.name, input.name);
  assert.deepEqual(toggled.json().task.daytime, created.json().task.daytime);
  assert.equal(toggled.json().task.enabled, false);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/settings/tasks/${id}`,
        headers,
        payload: { enabled: true, name: 'unexpected' },
      })
    ).statusCode,
    400,
  );

  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: `/api/settings/tasks/${id}`,
        headers,
        payload: { ...input, enabled: false },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/settings/tasks', headers })).json().tasks[0]
      .enabled,
    false,
  );
  assert.equal(
    (await app.inject({ method: 'DELETE', url: `/api/settings/tasks/${id}`, headers })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/settings/tasks', headers })).json().tasks.length,
    0,
  );
});

test('routine tasks keep complementary periods and retain independent rates', () => {
  const defaults = taskDefaults('daily');
  const changed = setDailyBoundary(defaults, 'nighttime', 'startTime', '21:00');
  assert.equal(changed.daytime.endTime, '21:00');
  const changedAgain = setDailyBoundary(changed, 'nighttime', 'endTime', '07:00');
  assert.equal(changedAgain.daytime.startTime, '07:00');
  assert.equal(changedAgain.daytime.intervalMinutes, 5);
  assert.equal(changedAgain.nighttime.intervalMinutes, 60);
  const daily: ScheduledTask = {
    ...defaults,
    id: 'daily',
    name: 'Routine',
    enabled: true,
    sourceIds: ['s'],
    updatedAt: '',
  };
  const review: ScheduledTask = {
    ...taskDefaults('review'),
    id: 'review',
    name: 'Review',
    sourceIds: ['s'],
    updatedAt: '',
  };
  assert.equal(taskConflict(daily, [daily]), 'schedule.sameTypeConflict');
  assert.equal(taskConflict(review, [daily]), null);
  assert.equal(dueTaskSlot(review, new Date('2026-09-26T21:59:00Z')), null);
  assert.ok(dueTaskSlot(review, new Date('2026-09-26T22:00:00Z')));
});

test('standalone review starts at its own hour, drains pending logs, and merges with a regular task at the same time', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-review-task-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'test',
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
  const review = settings.saveTask(
    { ...taskDefaults('review'), name: 'Review', sourceIds: [source.id] },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.put(LOG_CONTAINERS[0].name, path('05', '26'), [usage('review-only')]);
  let now = new Date('2026-09-26T21:59:00Z');
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => now,
  );
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await worker.tick();
  await worker.settled();
  assert.equal(reader.listings.length, 0);
  now = new Date('2026-09-26T22:00:00Z');
  await worker.tick();
  await worker.settled();
  assert.equal(worker.status().runs.length, 1);
  for (let i = 0; i < 4; i++) {
    now = new Date(now.getTime() + 10000);
    await worker.tick();
    await worker.settled();
  }
  assert.equal(worker.status().requestCount, 1);
  const completed = worker.status().runs.length;
  now = new Date(now.getTime() + 60000);
  await worker.tick();
  await worker.settled();
  assert.equal(worker.status().runs.length, completed);
  settings.saveTask({ ...taskDefaults('daily'), name: 'Day', sourceIds: [source.id] }, 'test');
  now = new Date('2026-09-27T22:00:00Z');
  const previous = worker.status().runs.length;
  await worker.tick();
  await worker.settled();
  assert.equal(worker.status().runs.length, previous + 1);
  assert.equal(worker.status().runs[0].mode, 'reconcile');
  assert.equal(
    settings.tasksForSource(source.id).some((task) => task.id === review.id),
    true,
  );
});

test('pending scan pages and unread blobs wait for the daily interval, including after restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-daily-interval-'));
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
      endpoint: 'https://interval.blob.core.windows.net',
      accountName: 'interval',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  settings.saveTask(
    {
      ...taskDefaults('daily'),
      name: 'Three-hour night',
      sourceIds: [source.id],
      daytime: { startTime: '08:00', endTime: '20:00', intervalMinutes: 5 },
      nighttime: { intervalMinutes: 180 },
    },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.pageSize = 1;
  for (let day = 1; day <= 8; day++)
    reader.put(LOG_CONTAINERS[0].name, path('02', String(day).padStart(2, '0')), [
      usage(`backlog-${day}`),
    ]);
  let now = new Date('2026-09-27T12:00:00Z');
  let statisticsRefreshes = 0;
  const makeWorker = () =>
    createImportWorker(
      db,
      settings,
      () => reader,
      () => now,
      async () => {
        statisticsRefreshes++;
      },
    );
  let worker = makeWorker();
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await worker.tick();
  assert.equal(worker.status().pendingScans, 0);
  assert.equal(worker.status().requestCount, 8);
  const firstCalls = reader.listings.length;
  for (const minutes of [1, 5, 49, 179]) {
    now = new Date(Date.parse('2026-09-27T12:00:00Z') + minutes * 60000);
    await worker.tick();
    assert.equal(reader.listings.length, firstCalls);
    assert.equal(statisticsRefreshes, 1);
  }
  await worker.stop();
  db.close();
  db = openDatabase(directory);
  settings = createSettingsRepository(db, createSecretStore(directory));
  worker = makeWorker();
  await worker.tick();
  assert.equal(reader.listings.length, firstCalls);
  now = new Date('2026-09-27T15:00:00Z');
  await worker.tick();
  assert.ok(reader.listings.length > firstCalls);
  assert.equal(statisticsRefreshes, 2);
  assert.equal(settings.listTasks()[0].executionCount, 2);
  assert.ok(reader.listings.some((list) => list.marker === '1'));
  // A ready-to-read blob is also not an independent scheduler trigger.
  db.connection.prepare('UPDATE import_blobs SET complete = 0').run();
  const secondCalls = reader.listings.length;
  now = new Date('2026-09-27T15:01:00Z');
  await worker.tick();
  assert.equal(reader.listings.length, secondCalls);
  // Daytime uses its five-minute interval with the same pending queue.
  now = new Date('2026-09-28T00:00:00Z');
  await worker.tick();
  const dayCalls = reader.listings.length;
  now = new Date('2026-09-28T00:01:00Z');
  await worker.tick();
  assert.equal(reader.listings.length, dayCalls);
  now = new Date('2026-09-28T00:05:00Z');
  await worker.tick();
  assert.ok(reader.listings.length > dayCalls);
});

test('reset stops active work before clearing history, retains imported data, and disables all schedules persistently', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-reset-'));
  const db = openDatabase(dir),
    settings = createSettingsRepository(db, createSecretStore(dir));
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://reset.blob.core.windows.net',
      accountName: 'reset',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  for (const type of ['daily', 'review'] as const)
    settings.saveTask({ ...taskDefaults(type), name: type, sourceIds: [source.id] }, 'test');
  const reader = new SyntheticBlobReader();
  reader.put(LOG_CONTAINERS[0].name, path(), [usage('retained')]);
  let time = new Date('2026-09-27T12:00:00Z');
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => time,
  );
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const preservedOperation = {
    id: 'keep-operation',
    time: new Date().toISOString(),
    category: 'operation' as const,
    level: 'info' as const,
    action: 'user.access',
    subject: 'fixture',
    actor: 'Tester',
    status: 'succeeded',
    details: 'role: user → admin',
  };
  db.logs.append(preservedOperation);
  db.logs.append({ ...preservedOperation, id: 'remove-task', category: 'task', action: 'manual' });
  await worker.tick();
  const factCount = (
    db.connection.prepare('SELECT count(*) n FROM request_facts').get() as { n: number }
  ).n;
  assert.equal(factCount, 1);
  let release!: () => void;
  reader.holdRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  reader.put(LOG_CONTAINERS[0].name, path('12', '27'), [usage('cancelled')]);
  const beforeReads = reader.reads.length;
  worker.request('scan');
  while (reader.reads.length === beforeReads) await new Promise((resolve) => setImmediate(resolve));
  const reset = worker.resetHistory('test');
  assert.throws(() => worker.request('scan'), { statusCode: 409 });
  release();
  const tasks = await reset;
  assert.deepEqual(
    db.logs
      .query({ category: 'operation', limit: 100, offset: 0 })
      .logs.find((log) => log.id === preservedOperation.id),
    preservedOperation,
  );
  assert.equal(db.logs.query({ category: 'task', limit: 100, offset: 0 }).total, 0);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => !task.enabled && task.executionCount === 0));
  for (const table of ['import_runs', 'task_executions', 'review_files', 'review_progress'])
    assert.equal(
      (db.connection.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
      0,
      table,
    );
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM request_facts').get() as { n: number }).n,
    factCount,
  );
  assert.equal(settings.getSources()[0].id, source.id);
  const reopened = openDatabase(dir);
  assert.ok(
    createSettingsRepository(reopened, createSecretStore(dir))
      .getTasks()
      .every((task) => !task.enabled),
  );
  reopened.close();
  time = new Date(time.getTime() + 86400000);
  await worker.tick();
  assert.equal(worker.status().runs.length, 0);
});

test('reset endpoint requires administrator authentication and explicit confirmation', async (t) => {
  const { app, cookie } = await testApp(t);
  const url = '/api/settings/tasks/reset-history';
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers: requestHeaders,
        payload: { confirmation: 'reset-task-history' },
      })
    ).statusCode,
    401,
  );
  const headers = { ...requestHeaders, cookie };
  assert.equal(
    (await app.inject({ method: 'POST', url, headers, payload: { confirmation: 'wrong' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url,
        headers,
        payload: { confirmation: 'reset-task-history' },
      })
    ).statusCode,
    200,
  );
});

test('reenabling waits for the planned time, manual scans do not consume scheduled slots, and cleared logs cannot retrigger tasks', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-trigger-boundaries-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://boundaries.blob.core.windows.net',
      accountName: 'boundaries',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  let task = settings.saveTask(
    { ...taskDefaults('daily'), name: 'Daily', enabled: true, sourceIds: [source.id] },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.put(LOG_CONTAINERS[0].name, path('04', '28'), [usage('first')]);
  let time = new Date('2026-09-28T04:00:00Z');
  const { createPlatformService } = await import('../src/server/platform/service.js');
  const platform = createPlatformService(db, settings);
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => time,
    undefined,
    () => platform.flush(),
  );
  t.after(async () => {
    await worker.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const executions = () =>
    (db.connection.prepare('SELECT count(*) n FROM task_executions').get() as { n: number }).n;
  await worker.tick();
  assert.equal(executions(), 1);
  assert.equal(worker.status().requestCount, 1);
  task = settings.saveTask({ ...task, enabled: false }, 'test', task.id);
  reader.put(LOG_CONTAINERS[0].name, path('05', '28'), [usage('while-disabled')]);
  time = new Date('2026-09-28T05:01:00Z');
  await worker.tick();
  const paused = reader.listings.length;
  task = settings.saveTask({ ...task, enabled: true }, 'test', task.id);
  await worker.tick();
  assert.equal(reader.listings.length, paused);
  worker.request('scan', true, undefined, undefined, 'Manual Admin');
  await worker.settled();
  assert.equal(worker.status().requestCount, 2);
  assert.equal(executions(), 1);
  assert.ok(
    platform
      .logs({ limit: 20, offset: 0 })
      .logs.some((log) => log.action === 'manual' && log.actor === 'Manual Admin'),
  );
  time = new Date('2026-09-28T05:05:00Z');
  await worker.tick();
  assert.equal(executions(), 2);
  const progress = db.connection
    .prepare('SELECT * FROM review_progress ORDER BY task_id,container')
    .all();
  platform.clearLogs();
  assert.equal(platform.logs({ limit: 20, offset: 0 }).total, 0);
  assert.deepEqual(
    db.connection.prepare('SELECT * FROM review_progress ORDER BY task_id,container').all(),
    progress,
  );
  time = new Date('2026-09-28T05:05:20Z');
  await worker.tick();
  assert.equal(executions(), 2);
  assert.equal(platform.logs({ limit: 20, offset: 0 }).total, 0);
  task = settings.saveTask({ ...task, enabled: false }, 'test', task.id);
  time = new Date('2026-09-28T06:01:00Z');
  reader.put(LOG_CONTAINERS[0].name, path('06', '28'), [usage('disabled-gap')]);
  task = settings.saveTask({ ...task, enabled: true }, 'test', task.id);
  await worker.tick();
  assert.equal(worker.status().requestCount, 2);
  time = new Date('2026-09-28T06:05:00Z');
  reader.failRead = true;
  await worker.tick();
  assert.equal(executions(), 3);
  reader.failRead = false;
  const failedReads = reader.reads.length;
  time = new Date('2026-09-28T06:06:00Z');
  await worker.tick();
  assert.equal(reader.reads.length, failedReads);
  time = new Date('2026-09-28T06:10:00Z');
  await worker.tick();
  assert.equal(executions(), 4);
  assert.equal(worker.status().requestCount, 3);
});
