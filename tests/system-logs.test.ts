import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogStore } from '../src/server/platform/log-store.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { openDatabase } from '../src/server/database.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import { safeAudit } from '../src/server/platform/audit-format.js';
import { DEFAULT_LOG_POLICY } from '../src/shared/platform.js';
import { testApp, requestHeaders, login, testPassword } from './helpers.js';

test('successful operations persist exact changed fields and never secret values; clearing removes history but not progress', async (t) => {
  const { app, cookie, directory } = await testApp(t, {
    async inspect() {
      return {
        endpoint: 'https://demo.blob.core.windows.net',
        accountName: 'demo',
        verifiedAt: new Date().toISOString(),
        containers: [...LOG_CONTAINERS],
      };
    },
  });
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/settings/sources',
    headers,
    payload: { authMode: 'connection_string', connectionString: 'SECRET_SENTINEL', containers: [] },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().source.id;
  await app.inject({
    method: 'PATCH',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: { enabled: false },
  });
  const page = await app.inject({ url: '/api/platform/logs?category=operation', headers });
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('demo'));
  assert.ok(page.body.includes('enabled: true → false'));
  assert.ok(page.body.includes('credential: updated'));
  assert.ok(!page.body.includes('SECRET_SENTINEL'));
  assert.ok(
    page
      .json()
      .logs.every(
        (log: { action: string; actor: string }) => log.action !== 'platform.http' && log.actor,
      ),
  );
  const db = openDatabase(directory);
  t.after(() => db.close());
  db.connection
    .prepare('INSERT INTO task_executions VALUES (?,?,?)')
    .run('task', 'slot', '2026-09-27T00:00:00Z');
  db.connection
    .prepare(
      `INSERT INTO import_runs(id,source_key,mode,started_at,status,trigger)
      VALUES ('finished','source','scan','2026-09-27T00:00:00Z','succeeded','manual')`,
    )
    .run();
  const cleared = await app.inject({
    method: 'POST',
    url: '/api/platform/clear-system-logs',
    headers,
    payload: { confirmation: 'clear-system-logs' },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(db.logs.query({ limit: 10, offset: 0 }).total, 0);
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM import_runs').get() as { n: number }).n,
    0,
  );
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM task_executions').get() as { n: number }).n,
    1,
  );
  assert.equal((await app.inject({ url: '/api/platform/logs', headers })).json().total, 0);
});

test('a change whose operation log cannot be written is rolled back', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-log-retry-'));
  const db = openDatabase(dir),
    settings = createSettingsRepository(db, createSecretStore(dir));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  settings.saveTask({ ...taskDefaults('daily'), name: 'Original', enabled: false }, 'tester');
  const task = settings.getTasks()[0];
  db.connection.exec(
    `CREATE TRIGGER reject_log BEFORE INSERT ON system_logs BEGIN SELECT RAISE(ABORT,'blocked'); END`,
  );
  assert.throws(() => settings.saveTask({ ...task, name: 'Second' }, 'tester', task.id), /blocked/);
  assert.equal(settings.getTasks()[0].name, 'Original');
  db.connection.exec('DROP TRIGGER reject_log');
  settings.saveTask({ ...task, name: 'Third' }, 'tester', task.id);
  const logs = db.logs.query({ limit: 20, offset: 0 }).logs;
  assert.ok(logs.some((log) => log.details.includes('name: "Original" → "Third"')));
  assert.deepEqual(
    safeAudit({ daytime: { password: 'SECRET', startTime: '08:00' }, connectionString: 'SECRET' }),
    { daytime: { startTime: '08:00' } },
  );
});

function fixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-sqlite-logs-'));
  const db = openDatabase(dir);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}
const entry = (id: string, time = '2026-09-27T00:00:00.000Z') => ({
  id,
  time,
  category: 'operation' as const,
  level: 'info' as const,
  action: 'source.update',
  subject: 'demo',
  actor: 'Admin',
  status: 'succeeded',
  details: 'name: old → new',
});

test('SQLite policy persists, filters future writes, and removes oldest logs by either size or age', (t) => {
  const { db } = fixture(t);
  let now = new Date('2026-09-27T00:00:00Z');
  const logs = createLogStore(db.connection, () => now);
  logs.savePolicy({ ...DEFAULT_LOG_POLICY, maxSizeMiB: 1, retentionDays: 90 });
  logs.append(entry('old', '2026-08-01T00:00:00.000Z'));
  logs.append(entry('new'));
  logs.savePolicy({
    ...logs.policy(),
    retentionDays: 30,
    eventTypes: ['delete'],
    levels: ['error'],
  });
  assert.deepEqual(
    logs.query({ limit: 10, offset: 0 }).logs.map((log) => log.id),
    ['new'],
  );
  logs.append(entry('filtered'));
  logs.append({ ...entry('allowed'), action: 'source.delete', level: 'error' });
  assert.equal(logs.query({ limit: 10, offset: 0 }).total, 2);
  assert.equal(logs.query({ search: 'missing', limit: 1, offset: 0 }).total, 0);
  assert.equal(logs.query({ search: 'demo', level: 'error', limit: 1, offset: 0 }).total, 1);
  assert.deepEqual(createLogStore(db.connection).policy(), logs.policy());
  logs.savePolicy({ ...DEFAULT_LOG_POLICY, maxSizeMiB: 1 });
  for (let i = 0; i < 100; i++) logs.append({ ...entry(`large-${i}`), details: 'x'.repeat(20000) });
  logs.prune(true);
  assert.ok(logs.size() <= 1024 * 1024);
  const page = logs.query({ limit: 200, offset: 0 });
  assert.ok(page.total < 100 && page.total > 0);
  assert.equal(page.logs[0].id, 'large-99');
  now = new Date('2026-10-28T00:00:00Z');
  assert.equal(logs.query({ limit: 10, offset: 0 }).total, 0);
});

test('log policy routes enforce admin access and numeric bounds and support disabling recording', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const url = '/api/platform/log-policy';
  assert.equal((await app.inject({ url })).statusCode, 401);
  assert.deepEqual((await app.inject({ url, headers })).json(), DEFAULT_LOG_POLICY);
  for (const payload of [
    { ...DEFAULT_LOG_POLICY, maxSizeMiB: 0 },
    { ...DEFAULT_LOG_POLICY, retentionDays: 0 },
    { ...DEFAULT_LOG_POLICY, maxSizeMiB: 1.5 },
    { ...DEFAULT_LOG_POLICY, eventTypes: ['other'] },
  ])
    assert.equal((await app.inject({ url, method: 'PUT', headers, payload })).statusCode, 400);
  const policy = { ...DEFAULT_LOG_POLICY, maxSizeMiB: 2, retentionDays: 7 };
  assert.equal(
    (await app.inject({ url, method: 'PUT', headers, payload: policy })).statusCode,
    200,
  );
  const logs = (await app.inject({ url: '/api/platform/logs', headers })).json().logs;
  assert.ok(
    logs.some(
      (log: { details: string; actor: string }) =>
        log.details.includes('retentionDays: 30 → 7') && log.actor,
    ),
  );
  assert.deepEqual((await app.inject({ url, headers })).json(), policy);
  await app.inject({
    url: '/api/users',
    method: 'POST',
    headers,
    payload: { email: 'reader@example.test', name: 'Reader', password: testPassword, role: 'user' },
  });
  const reader = { ...requestHeaders, cookie: await login(app, 'reader@example.test') };
  assert.equal((await app.inject({ url, headers: reader })).statusCode, 403);
  assert.equal(
    (await app.inject({ url, method: 'PUT', headers: reader, payload: policy })).statusCode,
    403,
  );
  const before = (await app.inject({ url: '/api/platform/logs', headers })).json().total;
  assert.equal(
    (
      await app.inject({
        url,
        method: 'PUT',
        headers,
        payload: { ...policy, eventTypes: [], levels: [] },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/api/platform/logs', headers })).json().total, before);
});

test('capacity cleanup retains recent history when a small log table only slightly exceeds its limit', (t) => {
  const { db } = fixture(t);
  const logs = createLogStore(db.connection, () => new Date('2026-09-27T00:00:00Z'));
  logs.savePolicy({ ...DEFAULT_LOG_POLICY, maxSizeMiB: 1 });
  for (let i = 0; i < 65; i++)
    logs.append({ ...entry(`bounded-${i}`), details: 'x'.repeat(16000) });
  logs.prune(true);
  const kept = logs.query({ limit: 100, offset: 0 });
  assert.ok(logs.size() <= 1024 * 1024);
  assert.ok(kept.total >= 60 && kept.total < 65, `retained ${kept.total} rows`);
  assert.equal(kept.logs[0].id, 'bounded-64');
  assert.equal(kept.logs.at(-1)?.id, `bounded-${65 - kept.total}`);
});

test('self-service profile and password changes record successful changes without leaking credentials', async (t) => {
  const { app, directory, cookie } = await testApp(t);
  const db = openDatabase(directory);
  t.after(() => db.close());
  const headers = { ...requestHeaders, cookie };
  const user = (await app.inject({ url: '/api/session', headers })).json().user;
  const query = () => db.logs.query({ category: 'operation', limit: 100, offset: 0 }).logs;
  const name = 'Self-service user';
  const changed = await app.inject({
    url: '/api/auth/update-user',
    method: 'POST',
    headers,
    payload: { name },
  });
  assert.equal(changed.statusCode, 200);
  let logs = query();
  const profile = logs.find((log) => log.action === 'user.profile');
  assert.ok(profile);
  assert.ok(
    profile.details.includes(`name: ${JSON.stringify(user.name)} → ${JSON.stringify(name)}`),
  );
  assert.equal(profile.actor, name);
  const count = logs.length;
  await app.inject({ url: '/api/auth/update-user', method: 'POST', headers, payload: { name } });
  assert.equal(query().length, count, 'unchanged profile is not a modification');
  const password = 'New-audit-password-sentinel!';
  const invalid = await app.inject({
    url: '/api/auth/change-password',
    method: 'POST',
    headers,
    payload: { currentPassword: 'invalid', newPassword: password, revokeOtherSessions: true },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(query().length, count, 'failed password update is not logged as success');
  const updated = await app.inject({
    url: '/api/auth/change-password',
    method: 'POST',
    headers,
    payload: { currentPassword: testPassword, newPassword: password, revokeOtherSessions: true },
  });
  assert.equal(updated.statusCode, 200);
  logs = query();
  const changedPassword = logs.find((log) => log.action === 'user.password');
  assert.ok(changedPassword);
  assert.equal(changedPassword.actor, name);
  assert.ok(changedPassword.details.includes('credential: updated'));
  assert.ok(!JSON.stringify(logs).includes(password));
  assert.ok(!JSON.stringify(logs).includes(testPassword));
  await login(app, 'admin@example.test', password);
});

test('capacity cleanup uses the sizes of oldest entries when large and small logs are mixed', (t) => {
  const { db } = fixture(t);
  const logs = createLogStore(db.connection, () => new Date('2026-09-27T00:00:00Z'));
  for (let i = 0; i < 1030; i++)
    logs.append({ ...entry(`mixed-${i}`), details: 'x'.repeat(i < 30 ? 16000 : 500) });
  logs.savePolicy({ ...DEFAULT_LOG_POLICY, maxSizeMiB: 1 });
  assert.ok(logs.size() <= 1024 * 1024);
  const kept = logs.query({ limit: 1100, offset: 0 });
  assert.ok(kept.total >= 1000 && kept.total < 1030, `retained ${kept.total} rows`);
  assert.ok(
    kept.logs.some((log) => log.id === 'mixed-30'),
    'recent small entries must be retained',
  );
  assert.equal(kept.logs[0].id, 'mixed-1029');
});
