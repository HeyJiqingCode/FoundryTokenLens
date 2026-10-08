import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { buildApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { login, setupAdmin } from './helpers.js';
import { APP_PAGES } from '../src/shared/navigation.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';

test('restart preserves the database identity and edited tasks', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-persistence-'));
  let activeDatabase: ReturnType<typeof openDatabase> | undefined;
  t.after(() => {
    activeDatabase?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = openDatabase(directory);
  activeDatabase = first;
  const id = first.instanceId;
  const task = createSettingsRepository(first, createSecretStore(directory)).saveTask(
    { ...taskDefaults('review'), name: 'Review', hour: 9, frequencyDays: 7 },
    'test',
  );
  first.close();
  activeDatabase = undefined;

  const second = openDatabase(directory);
  activeDatabase = second;
  assert.equal(second.instanceId, id);
  assert.deepEqual(createSettingsRepository(second, createSecretStore(directory)).getTasks(), [
    task,
  ]);
  assert.equal(second.connection.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(second.connection.pragma('journal_mode', { simple: true }), 'delete');
});

test('a database at another schema version is refused without modification', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const current = openDatabase(directory);
  const version = current.schemaVersion;
  current.close();
  for (const other of [version - 1, version + 1]) {
    const raw = new Database(join(directory, 'foundry-token-lens.sqlite'));
    raw.pragma(`user_version = ${other}`);
    raw.close();
    assert.throws(() => openDatabase(directory), /does not match this app/);
    const after = new Database(join(directory, 'foundry-token-lens.sqlite'));
    assert.equal(after.pragma('user_version', { simple: true }), other);
    after.pragma(`user_version = ${version}`);
    after.close();
  }
});

test('production server serves the UI, preserves API 404s, and excludes database files', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-http-'));
  const webDir = join(directory, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Foundry Token Lens</title>');
  const app = await buildApp({
    host: '127.0.0.1',
    port: 8080,
    dataDir: join(directory, 'data'),
    webDir,
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await setupAdmin(app);
  const health = await app.inject('/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');
  assert.equal((await app.inject('/api/bootstrap')).statusCode, 401);
  const cookie = await login(app);
  const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { cookie } });
  assert.deepEqual(bootstrap.json(), {
    version: health.json().version,
    dataStatus: 'not_connected',
  });

  for (const path of ['/login', '/settings', '/analysis', ...APP_PAGES.map((page) => page.path)]) {
    const page = await app.inject(`${path}?from=2026-09-01&model=fixture-chat`);
    assert.equal(page.statusCode, 200, path);
    assert.match(page.headers['content-type'] ?? '', /text\/html/);
    assert.equal(page.headers['cache-control'], 'no-cache');
    assert.equal((await app.inject({ method: 'HEAD', url: path })).statusCode, 200);
  }
  for (const url of [
    '/api/unknown',
    '/api/unknown?filter=x',
    '/api',
    '/assets/missing.js',
    '/data/foundry-token-lens.sqlite',
  ]) {
    assert.equal((await app.inject(url)).statusCode, 404, url);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/settings' })).statusCode, 404);
});

test('configuration rejects invalid ports', () => {
  for (const port of ['0', '65536', 'abc', '1.5']) {
    assert.throws(() => readConfig({ FTL_PORT: port }), /FTL_PORT/);
  }
});

test('a price scope allows only one unbounded start', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-unbounded-'));
  const database = openDatabase(directory);
  t.after(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const insert = database.connection.prepare(`INSERT INTO price_versions
    (id,scope_key,model,model_version,region,deployment_type,valid_from,items_json,notes,created_at,updated_at)
    VALUES (?,'scope','fixture','*','*','*',NULL,'[]','','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z')`);
  insert.run('unbounded');
  assert.throws(() => insert.run('duplicate'), /UNIQUE/);
});
