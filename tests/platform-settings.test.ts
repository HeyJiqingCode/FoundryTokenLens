import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/server/database.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { createPlatformService, LOG_DATA_TABLES } from '../src/server/platform/service.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { recordAudit } from '../src/server/platform/audit-format.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import { SyntheticBlobReader, path, usage } from './fixtures/diagnostics.js';
import { testApp, requestHeaders, login, testPassword } from './helpers.js';

test('clearing local log data drains active imports, keeps configurations and history, and invalidates report results', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-platform-clear-'));
  const db = openDatabase(directory),
    settings = createSettingsRepository(db, createSecretStore(directory));
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://platform.blob.core.windows.net',
      accountName: 'platform',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  settings.saveTask({ ...taskDefaults('daily'), name: 'Routine', sourceIds: [source.id] }, 'test');
  const reader = new SyntheticBlobReader();
  reader.put(LOG_CONTAINERS[0].name, path(), [usage('existing')]);
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => new Date('2026-09-27T12:00:00Z'),
  );
  db.connection.exec('CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT)');
  const analytics = createAnalyticsService(db, settings),
    platform = createPlatformService(db, settings),
    pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  settings.addPrice(
    {
      model: 'synthetic-model',
      modelVersion: '*',
      region: '*',
      deploymentType: '*',
      validFrom: null,
      validTo: null,
      notes: '',
      items: [{ key: 'input', label: 'Input', unitPriceUsd: '1', unitQuantity: 1000000 }],
    },
    'test',
  );
  await worker.tick();
  pricing.recalculate();
  assert.equal(platform.data().records, 1);
  assert.equal(analytics.report({}).summary.requests, 1);
  const sizes = platform.data();
  assert.ok(sizes.logBytes! > 0);
  assert.ok(sizes.otherBytes! > 0);
  assert.equal(
    sizes.logBytes! + sizes.otherBytes! + sizes.systemLogDatabaseBytes! + sizes.freeBytes,
    sizes.databaseBytes,
  );
  const historyCount = (
    db.connection.prepare('SELECT count(*) n FROM import_runs').get() as { n: number }
  ).n;
  let release!: () => void;
  reader.holdRead = new Promise((resolve) => {
    release = resolve;
  });
  reader.put(LOG_CONTAINERS[0].name, path('12', '27'), [usage('cancelled')]);
  const priorReads = reader.reads.length;
  worker.request('scan');
  while (reader.reads.length === priorReads) await new Promise((resolve) => setImmediate(resolve));
  const clearing = worker.clearLogData('test');
  assert.throws(() => worker.request('scan'), { statusCode: 409 });
  release();
  await clearing;
  for (const table of LOG_DATA_TABLES)
    assert.equal(
      (db.connection.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n,
      0,
      table,
    );
  assert.equal(analytics.report({}).summary.requests, 0);
  assert.equal(settings.listPrices().length, 1);
  assert.equal(settings.getSources()[0].id, source.id);
  assert.ok(settings.getTasks().every((task) => !task.enabled));
  assert.ok(
    (db.connection.prepare('SELECT count(*) n FROM import_runs').get() as { n: number }).n >=
      historyCount,
  );
  assert.ok(
    platform.logs({ category: 'operation', search: 'clearLogData', limit: 10, offset: 0 }).total ===
      1,
  );
  const reopen = openDatabase(directory);
  assert.equal(
    createSettingsRepository(reopen, createSecretStore(directory)).getTasks()[0].enabled,
    false,
  );
  reopen.close();
});

test('platform logs paginate, filter and omit sensitive audit snapshots', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const db = openDatabase(directory);
  t.after(() => db.close());
  recordAudit(db, {
    actor: 'actor',
    action: 'source.update',
    subject: 'safe-subject',
    before: { connectionString: 'SECRET_SENTINEL', password: 'PRIVATE_SENTINEL' },
    after: { connectionString: 'NEW_SECRET_SENTINEL', enabled: true },
  });
  const headers = { ...requestHeaders, cookie };
  const result = await app.inject({
    url: '/api/platform/logs?category=operation&search=source.update&limit=1',
    headers,
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().logs.length, 1);
  assert.ok(!/SECRET_SENTINEL|PRIVATE_SENTINEL/.test(result.body));
  assert.ok(!result.body.includes('before_json'));
  assert.equal(
    (
      await app.inject({
        url: '/api/platform/logs?category=operation&search=source.update&limit=1&offset=1',
        headers,
      })
    ).json().logs.length,
    0,
  );
  assert.equal(
    (await app.inject({ url: '/api/platform/logs?search=%25&category=operation', headers })).json()
      .logs.length,
    0,
  );
  const create = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { email: 'reader@example.test', name: 'Reader', password: testPassword, role: 'user' },
  });
  assert.equal(create.statusCode, 201);
  const readerCookie = await login(app, 'reader@example.test');
  assert.equal(
    (
      await app.inject({
        url: '/api/platform/logs',
        headers: { ...requestHeaders, cookie: readerCookie },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/platform/system-data',
        headers: { ...requestHeaders, cookie: readerCookie },
      })
    ).statusCode,
    200,
  );
  const clear = '/api/platform/clear-log-data';
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: clear,
        headers: { ...requestHeaders, cookie: readerCookie },
        payload: { confirmation: 'clear-log-data' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: clear, headers, payload: { confirmation: 'wrong' } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: clear,
        headers,
        payload: { confirmation: 'clear-log-data' },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/api/session', headers })).json().user.role, 'admin');
});

test('clear log data rolls back task disabling and deletions together on a database failure', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-platform-rollback-'));
  const db = openDatabase(directory),
    settings = createSettingsRepository(db, createSecretStore(directory));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.connection.prepare("INSERT INTO import_issues VALUES ('fixture','c','b',0,'h','r')").run();
  db.connection.exec(
    "CREATE TRIGGER refuse_clear BEFORE DELETE ON import_issues BEGIN SELECT RAISE(ABORT,'test rollback'); END",
  );
  assert.throws(() => settings.clearLogData('test'), /test rollback/);
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM import_issues').get() as { n: number }).n,
    1,
  );
  assert.equal(
    (
      db.connection
        .prepare("SELECT count(*) n FROM system_logs WHERE action='platform.clearLogData'")
        .get() as { n: number }
    ).n,
    0,
  );
});

test('clear monitoring endpoint retains system history, reclaims SQLite pages and does not create backups', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const db = openDatabase(directory);
  t.after(() => db.close());
  const time = new Date().toISOString();
  const operation = {
    id: 'retained-operation',
    time,
    category: 'operation' as const,
    level: 'info' as const,
    action: 'source.update',
    subject: 'fixture',
    actor: 'Tester',
    status: 'succeeded',
    details: 'enabled: true → false',
  };
  const task = {
    ...operation,
    id: 'retained-scan',
    category: 'task' as const,
    action: 'scheduled',
  };
  db.logs.append(operation);
  db.logs.append(task);
  db.connection
    .prepare("INSERT INTO import_issues VALUES ('large-fixture','c','b',0,'h',?)")
    .run('x'.repeat(4 * 1024 * 1024));
  const beforeSize = statSync(join(directory, 'foundry-token-lens.sqlite')).size;
  const headers = { ...requestHeaders, cookie };
  const response = await app.inject({
    url: '/api/platform/clear-log-data',
    method: 'POST',
    headers,
    payload: { confirmation: 'clear-log-data' },
  });
  assert.equal(response.statusCode, 200);
  const data = response.json();
  assert.equal(data.spaceReclaimed, true);
  assert.equal(data.records, 0);
  assert.equal(data.requests, 0);
  assert.ok(data.systemLogBytes > 0);
  assert.ok(data.databaseBytes < beforeSize / 2);
  assert.equal(data.databaseBytes, statSync(join(directory, 'foundry-token-lens.sqlite')).size);
  const logs = (await app.inject({ url: '/api/platform/logs', headers })).json().logs;
  assert.deepEqual(
    logs.find((log: { id: string }) => log.id === operation.id),
    operation,
  );
  assert.deepEqual(
    logs.find((log: { id: string }) => log.id === task.id),
    task,
  );
  assert.ok(logs.some((log: { action: string }) => log.action === 'platform.clearLogData'));
  assert.equal(existsSync(join(directory, 'backups')), false);
  assert.equal(db.connection.pragma('integrity_check', { simple: true }), 'ok');
});
