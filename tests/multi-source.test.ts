import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { createSourceStatistics } from '../src/server/settings/source-statistics.js';
import { buildApp } from '../src/server/app.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import {
  SyntheticBlobReader,
  containers,
  path,
  response,
  usage,
  now,
} from './fixtures/diagnostics.js';
import { testApp, requestHeaders, login, setupAdmin } from './helpers.js';

test('two enabled Blob sources import and price independently while reports deduplicate the same request', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-multi-source-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const readers = new Map<string, SyntheticBlobReader>();
  function save(name: string, enabled = true, id?: string) {
    const reader = readers.get(name) ?? new SyntheticBlobReader();
    readers.set(name, reader);
    return settings.saveSource(
      { authMode: 'connection_string', containers, enabled },
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
        verifiedAt: now.toISOString(),
      },
      'test',
      id,
    );
  }
  const one = save('first');
  const two = save('second');
  readers.get('first')!.put(containers[0], path('02', '20'), [usage('shared'), usage('one')]);
  readers.get('first')!.put(containers[0], path('02', '19'), [usage('older')]);
  readers.get('second')!.put(containers[0], path('02', '20'), [usage('shared'), usage('two')]);
  readers.get('second')!.put(containers[1], path('02', '20'), [response('two')]);
  const worker = createImportWorker(
    db,
    settings,
    (resolved) => readers.get(resolved.connectionString)!,
    () => now,
  );
  const pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  worker.request('scan');
  await worker.settled();
  assert.equal(settings.getSources().length, 2);
  assert.equal(worker.status().requestCount, 4);
  assert.equal(worker.status().runs.length, 2);
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM request_facts').get() as { n: number }).n,
    5,
  );
  settings.addPrice(
    {
      model: 'synthetic-model',
      modelVersion: '*',
      region: '*',
      deploymentType: '*',
      validFrom: null,
      validTo: null,
      notes: '',
      items: [
        { key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '1' },
        { key: 'cache_read', label: 'Cache read', unitQuantity: 1000000, unitPriceUsd: '0.1' },
        { key: 'output', label: 'Output', unitQuantity: 1000000, unitPriceUsd: '4' },
      ],
    },
    'test',
  );
  assert.equal(pricing.recalculate(20), 5);
  const analytics = createAnalyticsService(db, settings);
  assert.equal(analytics.report({}).summary.requests, 4);
  assert.equal(analytics.requests({}, 25).total, 4);
  assert.equal(analytics.report({}).summary.costUsd, '0.000924');
  const statistics = createSourceStatistics(db, settings, (resolved) =>
    readers.get(resolved.connectionString)!,
  );
  assert.equal((await statistics.refresh(one.id)).files, 2);
  assert.equal((await statistics.refresh(two.id)).files, 2);
  save('second', false, two.id);
  assert.equal(worker.status().requestCount, 3);
  assert.equal(analytics.report({}).summary.requests, 3);
  settings.deleteSource(one.id, 'test');
  assert.equal(analytics.report({}).summary.requests, 0);
  assert.equal(
    pricing.state().models?.some((model) => model.model === 'synthetic-model' && model.fromLogs),
    true, // Existing prices retain their log origin even when no source is active.
  );
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM request_facts').get() as { n: number }).n,
    5,
  );
  save('first');
  assert.equal(analytics.report({}).summary.requests, 3);
});

test('source management API lists safe settings, rejects duplicates, validates deletion and survives a disabled source', async (t) => {
  const inspector = {
    async inspect(source: { connectionString: string }) {
      const name = source.connectionString;
      return {
        endpoint: `https://${name}.blob.core.windows.net`,
        accountName: name,
        containers: [...LOG_CONTAINERS],
        verifiedAt: now.toISOString(),
      };
    },
  };
  const { app, cookie } = await testApp(t, inspector);
  const headers = { ...requestHeaders, cookie };
  const payload = (name: string, enabled = true) => ({
    authMode: 'connection_string',
    connectionString: name,
    containers: [containers[0]],
    enabled,
  });
  const create = async (name: string) =>
    app.inject({ method: 'POST', url: '/api/settings/sources', headers, payload: payload(name) });
  const first = await create('first');
  const second = await create('second');
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  const id = second.json().source.id as string;
  const listed = await app.inject({ method: 'GET', url: '/api/settings/sources', headers });
  assert.equal(listed.json().sources.length, 2);
  assert.equal(listed.body.includes('connectionString'), false);
  const totals = await app.inject({
    method: 'GET',
    url: `/api/settings/sources/${id}/statistics`,
    headers,
  });
  assert.equal(totals.statusCode, 200);
  assert.deepEqual(totals.json(), { statistics: null });
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/settings/sources/${id}/statistics/refresh`,
        headers: requestHeaders,
      })
    ).statusCode,
    401,
  );
  assert.equal((await create('second')).statusCode, 409);
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().source.enabled, false);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/bootstrap', headers })).json().dataStatus,
    'configured',
  );
  const wrong = await app.inject({
    method: 'DELETE',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: { confirmation: 'wrong' },
  });
  assert.equal(wrong.statusCode, 400);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: { confirmation: 'second' },
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/settings/sources', headers })).json().sources
      .length,
    1,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/settings/sources/${id}/statistics`, headers }))
      .statusCode,
    404,
  );
});

test('multiple encrypted Blob connections remain editable after a service restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-multi-restart-'));
  const config = {
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: join(directory, 'web'),
  };
  const inspector = {
    async inspect(source: { connectionString: string }) {
      return {
        endpoint: `https://${source.connectionString}.blob.core.windows.net`,
        accountName: source.connectionString,
        containers: [...LOG_CONTAINERS],
        verifiedAt: now.toISOString(),
      };
    },
  };
  let app = await buildApp(config, false, { sourceInspector: inspector });
  await setupAdmin(app);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let cookie = await login(app);
  const headers = { ...requestHeaders, cookie };
  let secondId = '';
  for (const name of ['first', 'second']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      headers,
      payload: {
        authMode: 'connection_string',
        connectionString: name,
        containers: [containers[0]],
      },
    });
    assert.equal(response.statusCode, 201);
    if (name === 'second') secondId = response.json().source.id;
  }
  await app.close();
  app = await buildApp(config, false, { sourceInspector: inspector });
  cookie = await login(app);
  const restored = await app.inject({
    method: 'GET',
    url: '/api/settings/sources',
    headers: { ...requestHeaders, cookie },
  });
  assert.deepEqual(
    restored.json().sources.map((source: { accountName: string }) => source.accountName),
    ['first', 'second'],
  );
  const edited = await app.inject({
    method: 'PUT',
    url: `/api/settings/sources/${secondId}`,
    headers: { ...requestHeaders, cookie },
    payload: {
      authMode: 'connection_string',
      useSavedCredential: true,
      containers: [containers[0]],
      enabled: true,
    },
  });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().source.accountName, 'second');
});
