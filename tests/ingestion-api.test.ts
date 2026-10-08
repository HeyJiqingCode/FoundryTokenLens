import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { login, requestHeaders, setupAdmin, testPassword } from './helpers.js';
import { SyntheticBlobReader, containers, path, usage } from './fixtures/diagnostics.js';

test('ingestion HTTP flow is authenticated, admin-only for execution, and returns actual requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-ingestion-api-'));
  const reader = new SyntheticBlobReader();
  reader.put(containers[0], path(), [usage('api-fixture')]);
  const app = await buildApp(
    {
      host: '127.0.0.1',
      port: 8080,
      dataDir: directory,
      webDir: join(directory, 'web'),
    },
    false,
    {
      blobReader: () => reader,
      workerEnabled: true,
      sourceInspector: {
        async inspect() {
          return {
            endpoint: 'https://synthetic.blob.core.windows.net',
            accountName: 'synthetic',
            containers: [...LOG_CONTAINERS],
            verifiedAt: new Date().toISOString(),
          };
        },
      },
    },
  );
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  assert.equal((await app.inject('/api/ingestion')).statusCode, 401);
  assert.equal((await app.inject('/api/requests')).statusCode, 401);
  const headers = { ...requestHeaders, cookie: await login(app) };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ingestion/run',
        headers,
        payload: { mode: 'scan' },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/settings/sources',
        headers,
        payload: {
          authMode: 'connection_string',
          connectionString: 'synthetic-not-real',
          containers,
        },
      })
    ).statusCode,
    201,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ingestion/run',
        headers: { cookie: headers.cookie },
        payload: { mode: 'scan' },
      })
    ).statusCode,
    403,
  );
  const started = await app.inject({
    method: 'POST',
    url: '/api/ingestion/run',
    headers,
    payload: { mode: 'scan' },
  });
  assert.equal(started.statusCode, 202);
  let status = (await app.inject({ url: '/api/ingestion', headers })).json();
  for (let i = 0; status.running && i < 30; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    status = (await app.inject({ url: '/api/ingestion', headers })).json();
  }
  assert.equal(status.requestCount, 1);
  assert.equal(status.running, false);
  // Views hide calls of a model until it has a price; background recalculation brings them back.
  assert.equal((await app.inject({ url: '/api/requests', headers })).json().total, 0);
  assert.equal((await app.inject({ url: '/api/analytics', headers })).json().summary.requests, 0);
  assert.deepEqual((await app.inject({ url: '/api/analytics/facets', headers })).json().models, []);
  const priced = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: {
      model: 'synthetic-model',
      modelVersion: '*',
      region: '*',
      deploymentType: '*',
      validFrom: null,
      validTo: null,
      notes: '',
      items: [{ key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '1' }],
    },
  });
  assert.equal(priced.statusCode, 201, priced.body);
  let listed = (await app.inject({ url: '/api/requests', headers })).json();
  for (let i = 0; !listed.total && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    listed = (await app.inject({ url: '/api/requests', headers })).json();
  }
  assert.equal(listed.requests[0].correlationId, 'api-fixture');
  const request = (await app.inject({ url: '/api/requests', headers })).json().requests[0];
  const evidence = await app.inject({
    url: `/api/requests/evidence?${new URLSearchParams({ resourceId: request.resourceId, correlationId: request.correlationId })}`,
    headers,
  });
  assert.equal(evidence.statusCode, 200);
  assert.equal(evidence.json().records[0].blobName, path());
  assert.equal((await app.inject({ url: '/api/requests?limit=100000', headers })).statusCode, 400);
  await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: {
      email: 'viewer@example.test',
      name: 'Synthetic viewer',
      password: testPassword,
      role: 'user',
    },
  });
  const viewer = { ...requestHeaders, cookie: await login(app, 'viewer@example.test') };
  assert.equal((await app.inject({ url: '/api/requests', headers: viewer })).statusCode, 200);
  assert.equal(
    (await app.inject({ url: '/api/analytics', headers: viewer })).json().summary.requests,
    1,
  );
  assert.equal(
    (await app.inject({ url: '/api/requests?model=no-match', headers: viewer })).json().total,
    0,
  );
  const csv = await app.inject({ url: '/api/requests/export.csv', headers: viewer });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'] ?? '', /text\/csv/);
  assert.match(csv.body, /api-fixture/);
  assert.match(csv.body.split('\r\n')[0], /"cost_usd"/);
  assert.doesNotMatch(csv.body.split('\r\n')[0], /known_usd|cost_status|total_usd/);
  assert.equal((await app.inject('/api/requests/export.csv')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/ingestion', headers: viewer })).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ingestion/run',
        headers: viewer,
        payload: { mode: 'reconcile' },
      })
    ).statusCode,
    403,
  );
});

test('manual scan validates selected sources and reads only that scope without running scheduled tasks', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-selected-scan-'));
  const readers = new Map(
    ['first', 'second', 'disabled'].map((name) => {
      const reader = new SyntheticBlobReader();
      reader.put(containers[0], path(), [usage(name)]);
      return [name, reader] as const;
    }),
  );
  const app = await buildApp(
    {
      host: '127.0.0.1',
      port: 8080,
      dataDir: directory,
      webDir: join(directory, 'web'),
    },
    false,
    {
      blobReader: (source) => readers.get(source.connectionString!)!,
      sourceInspector: {
        async inspect(source) {
          const name = source.connectionString!;
          return {
            endpoint: `https://${name}.blob.core.windows.net`,
            accountName: name,
            containers: [...LOG_CONTAINERS],
            verifiedAt: new Date().toISOString(),
          };
        },
      },
    },
  );
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const headers = { ...requestHeaders, cookie: await login(app) };
  const ids: string[] = [];
  for (const name of readers.keys()) {
    const saved = await app.inject({
      method: 'POST',
      url: '/api/settings/sources',
      headers,
      payload: { authMode: 'connection_string', connectionString: name, containers },
    });
    assert.equal(saved.statusCode, 201);
    ids.push(saved.json().source.id);
  }
  await app.inject({
    method: 'PATCH',
    url: `/api/settings/sources/${ids[2]}`,
    headers,
    payload: { enabled: false },
  });
  const scan = (sourceIds: string[]) =>
    app.inject({
      method: 'POST',
      url: '/api/ingestion/run',
      headers,
      payload: { mode: 'scan', sourceIds },
    });
  for (const [selection, expected] of [
    [[], 400],
    [[ids[0], ids[0]], 400],
    [['missing'], 409],
    [[ids[0], ids[2]], 409],
  ] as [string[], number][]) {
    assert.equal((await scan(selection)).statusCode, expected);
  }
  assert.ok([...readers.values()].every((reader) => reader.listings.length === 0));
  const waitUntilFinished = async () => {
    for (let i = 0; i < 100; i++) {
      const status = (await app.inject({ url: '/api/ingestion', headers })).json();
      if (!status.running) return status;
      await new Promise(setImmediate);
    }
    assert.fail('Scan did not finish');
  };
  assert.equal((await scan([ids[1]])).statusCode, 202);
  assert.equal((await waitUntilFinished()).requestCount, 1);
  assert.equal(readers.get('first')!.listings.length, 0);
  assert.ok(readers.get('second')!.listings.length > 0);
  assert.equal(readers.get('disabled')!.listings.length, 0);
  let release!: () => void;
  readers.get('first')!.holdRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    assert.equal((await scan(ids.slice(0, 2))).statusCode, 202);
    assert.equal((await scan([ids[1]])).statusCode, 409);
  } finally {
    release();
  }
  assert.equal((await waitUntilFinished()).requestCount, 2);
  assert.ok(readers.get('first')!.listings.length > 0);
  assert.equal(readers.get('disabled')!.listings.length, 0);
  const tasks = (await app.inject({ url: '/api/settings/tasks', headers })).json().tasks;
  assert.ok(tasks.every((task: { executionCount: number }) => task.executionCount === 0));
});
