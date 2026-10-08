import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { openDatabase } from '../src/server/database.js';
import { HttpError } from '../src/server/http/errors.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import type { SourceInspector } from '../src/server/sources/azure-blob.js';
import { login, requestHeaders, testApp, testPassword } from './helpers.js';

const syntheticCredential =
  'DefaultEndpointsProtocol=https;AccountName=fixtureacct;AccountKey=TEST_ONLY_NOT_A_REAL_SECRET';
const sourcePayload = {
  authMode: 'connection_string',
  connectionString: syntheticCredential,
  containers: LOG_CONTAINERS.map((item) => item.name),
};
const inspector: SourceInspector = {
  async inspect(source) {
    if (source.authMode === 'managed_identity')
      throw new HttpError(400, 'sources.managedIdentityAuthenticationFailed');
    return {
      accountName: 'fixtureacct',
      endpoint: 'https://fixtureacct.blob.core.windows.net',
      containers: LOG_CONTAINERS.map((item) => ({ ...item })),
      verifiedAt: new Date().toISOString(),
    };
  },
};

test('source settings require admin, encrypt secrets, and survive reopening without returning credentials', async (t) => {
  const { app, directory, cookie } = await testApp(t, inspector);
  const headers = { ...requestHeaders, cookie };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/settings/sources',
        headers: requestHeaders,
        payload: sourcePayload,
      })
    ).statusCode,
    401,
  );
  const tested = await app.inject({
    method: 'POST',
    url: '/api/settings/source/test',
    headers,
    payload: { ...sourcePayload, containers: [] },
  });
  assert.equal(tested.statusCode, 200);
  assert.equal(tested.json().containers.length, 2);
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings/sources',
    headers,
    payload: sourcePayload,
  });
  assert.equal(saved.statusCode, 201);
  assert.equal(saved.json().source.hasConnectionString, true);
  assert.equal(saved.body.includes(syntheticCredential), false);
  assert.equal('connectionString' in saved.json().source, false);
  assert.equal('encryptedCredential' in saved.json().source, false);
  const id = saved.json().source.id;
  const raw = readFileSync(join(directory, 'foundry-token-lens.sqlite'));
  assert.equal(raw.includes(Buffer.from(syntheticCredential)), false);

  const reopened = openDatabase(directory);
  try {
    const repository = createSettingsRepository(reopened, createSecretStore(directory));
    assert.equal(
      repository.resolveSource(
        { authMode: 'connection_string', useSavedCredential: true, containers: [] },
        id,
      ).connectionString,
      syntheticCredential,
    );
    assert.equal(repository.getSources()[0].containers.length, 2);
  } finally {
    reopened.close();
  }

  const savedCredential = {
    authMode: 'connection_string',
    useSavedCredential: true,
    containers: [LOG_CONTAINERS[0].name],
  };
  const unnamed = await app.inject({
    method: 'POST',
    url: '/api/settings/source/test',
    headers,
    payload: savedCredential,
  });
  assert.equal(unnamed.statusCode, 400);
  assert.equal(unnamed.json().code, 'sources.savedCredentialNeedsSource');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/settings/source/test?sourceId=${id}`,
        headers,
        payload: savedCredential,
      })
    ).statusCode,
    200,
  );
  const reused = await app.inject({
    method: 'PUT',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: savedCredential,
  });
  assert.equal(reused.statusCode, 200);
  assert.equal(reused.json().source.containers.length, 2);
  const failed = await app.inject({
    method: 'PUT',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: {
      authMode: 'managed_identity',
      endpoint: 'https://fixtureacct.blob.core.windows.net',
      containers: sourcePayload.containers,
    },
  });
  assert.equal(failed.statusCode, 400);
  assert.equal(
    (await app.inject({ url: '/api/settings/sources', headers })).json().sources[0].authMode,
    'connection_string',
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/settings/source/test',
        headers,
        payload: {
          ...sourcePayload,
          authMode: 'managed_identity',
          endpoint: 'https://fixtureacct.blob.core.windows.net',
        },
      })
    ).statusCode,
    400,
  );
});

test('manual price versions close previous intervals and preserve exact decimal strings and corrections', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const draft = {
    model: 'fixture-model',
    modelVersion: '*',
    region: '*',
    deploymentType: 'Global Standard',
    validFrom: '2026-09-01T00:00:00Z',
    validTo: null,
    items: [{ key: 'input', label: '输入', unitQuantity: 1000000, unitPriceUsd: '0' }],
    notes: 'Synthetic fixture',
  };
  const first = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: draft,
  });
  assert.equal(first.statusCode, 201);
  const id = first.json().price.id;
  const second = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: {
      ...draft,
      validFrom: '2026-10-01T00:00:00Z',
      items: [{ ...draft.items[0], unitPriceUsd: '0.123456789012' }],
    },
  });
  assert.equal(second.statusCode, 201);
  const middle = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: { ...draft, validFrom: '2026-09-20T08:00:00+08:00' },
  });
  assert.equal(middle.statusCode, 201);
  assert.equal(middle.json().price.validTo, '2026-10-01T00:00:00.000Z');
  const prices = (await app.inject({ url: '/api/settings/prices', headers })).json().prices;
  assert.equal(
    prices.find((price: { id: string }) => price.id === id).validTo,
    '2026-09-20T00:00:00.000Z',
  );
  assert.equal(prices[0].items[0].unitPriceUsd, '0.123456789012');
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/settings/prices', headers, payload: draft }))
      .statusCode,
    409,
  );
  const correction = await app.inject({
    method: 'PATCH',
    url: `/api/settings/prices/${id}`,
    headers,
    payload: { items: [{ ...draft.items[0], unitPriceUsd: '2.5000' }], notes: 'Corrected fixture' },
  });
  assert.equal(correction.statusCode, 200);
  assert.equal(correction.json().price.items[0].unitPriceUsd, '2.5000');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/settings/prices',
        headers,
        payload: { ...draft, model: 'bad', items: [{ ...draft.items[0], unitPriceUsd: '' }] },
      })
    ).statusCode,
    400,
  );
  const db = openDatabase(directory);
  try {
    assert.ok(
      db.logs.query({ category: 'operation', search: 'price.correct', limit: 100, offset: 0 })
        .total > 0,
    );
  } finally {
    db.close();
  }
});

test('read-only users cannot configure sources or prices and the last admin cannot be disabled', async (t) => {
  const { app, cookie } = await testApp(t, inspector);
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: {
      email: 'reader@example.test',
      name: '只读用户',
      password: testPassword,
      role: 'user',
    },
  });
  assert.equal(created.statusCode, 201);
  const viewerCookie = await login(app, 'reader@example.test');
  const viewerHeaders = { ...requestHeaders, cookie: viewerCookie };
  assert.equal(
    (await app.inject({ url: '/api/settings/sources', headers: viewerHeaders })).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/settings/tasks',
        headers: viewerHeaders,
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/admin/create-user',
        headers: viewerHeaders,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/update-user',
        headers: viewerHeaders,
        payload: { name: 'Reader', username: 'reader', role: 'admin' },
      })
    ).statusCode,
    400,
  );
  const admin = (await app.inject({ url: '/api/session', headers })).json().user;
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/users/${admin.id}/access`,
        headers,
        payload: { role: 'user', enabled: false },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/users/${created.json().user.id}/access`,
        headers,
        payload: { role: 'user', enabled: false },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: '/api/bootstrap', headers: viewerHeaders })).statusCode,
    401,
  );
});

test('source saves automatically associate detected diagnostic containers and reject an empty detection', async (t) => {
  let detected = LOG_CONTAINERS.slice(0, 2);
  const { app, cookie } = await testApp(t, {
    async inspect() {
      return {
        endpoint: 'https://autologs.blob.core.windows.net',
        accountName: 'autologs',
        verifiedAt: new Date().toISOString(),
        containers: [...detected],
      };
    },
  });
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/settings/sources',
    headers,
    payload: { ...sourcePayload, containers: [] },
  });
  assert.equal(created.statusCode, 201);
  assert.deepEqual(
    created.json().source.containers,
    detected.map((item) => item.name),
  );
  const id = created.json().source.id;
  detected = LOG_CONTAINERS.slice(1, 2);
  const updated = await app.inject({
    method: 'PUT',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: sourcePayload,
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(
    updated.json().source.containers,
    detected.map((item) => item.name),
  );
  detected = [];
  const empty = await app.inject({
    method: 'PUT',
    url: `/api/settings/sources/${id}`,
    headers,
    payload: sourcePayload,
  });
  assert.equal(empty.statusCode, 400);
  const saved = await app.inject({ method: 'GET', url: '/api/settings/sources', headers });
  assert.deepEqual(saved.json().sources[0].containers, [LOG_CONTAINERS[1].name]);
});
