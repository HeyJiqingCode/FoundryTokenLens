import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PriceInput, PriceVersion } from '../src/shared/settings.js';
import type { PriceModelIdentity } from '../src/shared/pricing.js';
import { openDatabase } from '../src/server/database.js';
import { hash, parseRecord } from '../src/server/ingestion/parser.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { modelPrices } from '../src/web/features/settings/prices/model-prices.js';
import { usage, resource } from './fixtures/diagnostics.js';
import { login, requestHeaders, testApp, testPassword } from './helpers.js';

const draft: PriceInput = {
  model: 'manual-model',
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  notes: '',
  items: [{ key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '2' }],
};
const sourceEndpoint = 'https://synthetic.blob.core.windows.net';
function configureSource(database: ReturnType<typeof openDatabase>, directory: string) {
  createSettingsRepository(database, createSecretStore(directory)).saveSource(
    { authMode: 'connection_string', containers: [LOG_CONTAINERS[0].name] },
    {
      authMode: 'connection_string',
      connectionString: 'test-only',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: sourceEndpoint,
      accountName: 'synthetic',
      containers: [LOG_CONTAINERS[0]],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
}
function logModel(database: ReturnType<typeof openDatabase>, model: string, id = model) {
  const fact = parseRecord(JSON.stringify(usage(id, { modelName: model })), 'usage', resource)[0]
    .fact!;
  database.connection
    .prepare('INSERT INTO request_facts VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)')
    .run(hash(sourceEndpoint), resource, id, fact.time, JSON.stringify(fact));
}
function snapshot(database: ReturnType<typeof openDatabase>) {
  return JSON.stringify(
    ['price_versions', 'request_facts', 'request_costs', 'settings', 'system_logs'].map((table) =>
      database.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ),
  );
}

test('model creation rejects existing log and manual IDs, including hidden rows and case differences', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const db = openDatabase(directory);
  try {
    configureSource(db, directory);
    logModel(db, 'gpt-log-model');
    const create = (model: string) =>
      app.inject({
        method: 'POST',
        url: '/api/pricing/models',
        headers,
        payload: { displayName: 'Test model', price: { ...draft, model } },
      });
    assert.equal((await create('manual-model')).statusCode, 201);
    for (const model of ['gpt-log-model', ' GPT-LOG-MODEL ', 'manual-model', ' MANUAL-MODEL ']) {
      const before = snapshot(db);
      const response = await create(model);
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, 'pricing.modelAlreadyExists');
      assert.equal(snapshot(db), before);
    }
    await app.inject({
      method: 'DELETE',
      url: '/api/pricing/models',
      headers,
      payload: { model: 'gpt-log-model', confirmation: 'gpt-log-model' },
    });
    assert.equal((await create('gpt-log-model')).statusCode, 409);
    const concurrent = await Promise.all([create('new-model'), create('NEW-MODEL')]);
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 409]);
    const prices = (await app.inject({ url: '/api/settings/prices', headers })).json().prices;
    assert.equal(prices.length, 2);
  } finally {
    db.close();
  }
});

test('manual rename and display name persist with all price history, and invalid edits roll back together', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const db = openDatabase(directory);
  try {
    configureSource(db, directory);
    const initial = await app.inject({
      method: 'POST',
      url: '/api/pricing/models',
      headers,
      payload: { displayName: 'Original display', price: draft },
    });
    assert.equal(initial.statusCode, 201);
    const first = initial.json().price as PriceVersion;
    const next = await app.inject({
      method: 'PUT',
      url: '/api/pricing/models',
      headers,
      payload: {
        originalModel: draft.model,
        displayName: 'Original display',
        price: { ...draft, validFrom: '2026-10-01T00:00:00.000Z' },
      },
    });
    assert.equal(next.statusCode, 200);
    const second = next.json().price as PriceVersion;
    logModel(db, 'protected-log-model');
    const facts = db.connection.prepare('SELECT * FROM request_facts').all();
    const rename = (model: string, validFrom: string | null = second.validFrom) =>
      app.inject({
        method: 'PUT',
        url: '/api/pricing/models',
        headers,
        payload: {
          originalModel: draft.model,
          displayName: 'Edited display',
          priceId: second.id,
          price: { ...draft, model, validFrom },
        },
      });
    for (const [model, from] of [
      ['protected-log-model', second.validFrom],
      ['renamed-model', draft.validFrom],
    ] as const) {
      const before = snapshot(db);
      assert.equal((await rename(model, from)).statusCode, 409);
      assert.equal(snapshot(db), before);
    }
    const renamed = await rename('renamed-model');
    assert.equal(renamed.statusCode, 200);
    const prices = (await app.inject({ url: '/api/settings/prices', headers })).json()
      .prices as PriceVersion[];
    assert.deepEqual(prices.map((price) => price.id).sort(), [first.id, second.id].sort());
    assert.ok(prices.every((price) => price.model === 'renamed-model'));
    assert.equal(prices.find((price) => price.id === first.id)?.validTo, second.validFrom);
    const identities = (await app.inject({ url: '/api/pricing', headers })).json()
      .models as PriceModelIdentity[];
    assert.deepEqual(
      identities.find((model) => model.model === 'renamed-model'),
      { model: 'renamed-model', displayName: 'Edited display', fromLogs: false },
    );
    const visible = modelPrices([], prices, [], identities);
    assert.equal(visible[0].displayName, 'Edited display');
    assert.equal(visible[0].fromLogs, false);
    assert.deepEqual(db.connection.prepare('SELECT * FROM request_facts').all(), facts);
    const reopened = openDatabase(directory);
    try {
      const profiles = reopened.connection
        .prepare("SELECT value_json FROM settings WHERE key = 'model_profiles'")
        .get() as { value_json: string };
      assert.deepEqual(JSON.parse(profiles.value_json), [
        { model: 'renamed-model', displayName: 'Edited display' },
      ]);
    } finally {
      reopened.close();
    }
    // A manually configured model becomes log-backed as soon as real usage arrives.
    logModel(db, 'renamed-model');
    const before = snapshot(db);
    const locked = await app.inject({
      method: 'PUT',
      url: '/api/pricing/models',
      headers,
      payload: {
        originalModel: 'renamed-model',
        displayName: 'Changed',
        priceId: second.id,
        price: { ...draft, model: 'different-model', validFrom: second.validFrom },
      },
    });
    assert.equal(locked.statusCode, 409);
    assert.equal(locked.json().code, 'pricing.logModelIdReadOnly');
    assert.equal(snapshot(db), before);
    const displayOnly = await app.inject({
      method: 'PUT',
      url: '/api/pricing/models',
      headers,
      payload: {
        originalModel: 'renamed-model',
        displayName: 'Readable log model',
        priceId: second.id,
        price: { ...draft, model: 'renamed-model', validFrom: second.validFrom },
      },
    });
    assert.equal(displayOnly.statusCode, 200);
    const updated = (await app.inject({ url: '/api/pricing', headers })).json()
      .models as PriceModelIdentity[];
    assert.equal(
      updated.find((model) => model.model === 'renamed-model')?.displayName,
      'Readable log model',
    );
    const beforeDeleteFacts = db.connection.prepare('SELECT * FROM request_facts').all();
    await app.inject({
      method: 'DELETE',
      url: '/api/pricing/models',
      headers,
      payload: { model: 'renamed-model', confirmation: 'renamed-model' },
    });
    const refreshed = (
      await app.inject({ method: 'POST', url: '/api/pricing/models/refresh', headers, payload: {} })
    ).json();
    assert.equal(
      refreshed.models.find((model: PriceModelIdentity) => model.model === 'renamed-model')
        .displayName,
      null,
    );
    assert.deepEqual(db.connection.prepare('SELECT * FROM request_facts').all(), beforeDeleteFacts);
  } finally {
    db.close();
  }
});

test('identity editing remains admin-only and cannot edit a different model through its price ID', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const body = { displayName: 'Manual', price: draft };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/pricing/models',
        headers: requestHeaders,
        payload: body,
      })
    ).statusCode,
    401,
  );
  const other = await app.inject({
    method: 'POST',
    url: '/api/pricing/models',
    headers,
    payload: body,
  });
  assert.equal(other.statusCode, 201);
  await app.inject({
    method: 'POST',
    url: '/api/pricing/models',
    headers,
    payload: { ...body, price: { ...draft, model: 'other-model' } },
  });
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/pricing/models',
        headers,
        payload: {
          ...body,
          originalModel: 'other-model',
          priceId: other.json().price.id,
          price: { ...draft, model: 'other-model' },
        },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/pricing/models',
        headers: { ...headers, origin: 'https://untrusted.example' },
        payload: body,
      })
    ).statusCode,
    403,
  );
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { email: 'reader@example.test', name: 'Reader', password: testPassword, role: 'user' },
  });
  assert.equal(created.statusCode, 201);
  const reader = await login(app, 'reader@example.test');
  for (const method of ['POST', 'PUT'] as const)
    assert.equal(
      (
        await app.inject({
          method,
          url: '/api/pricing/models',
          headers: { ...requestHeaders, cookie: reader },
          payload: body,
        })
      ).statusCode,
      403,
    );
});

test('disabling or removing a source never makes its existing log model editable as a manual model', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const db = openDatabase(directory);
  t.after(() => db.close());
  configureSource(db, directory);
  logModel(db, 'protected-model');
  logModel(db, 'hidden-unpriced-model');
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const price = settings.addPrice({ ...draft, model: 'protected-model' }, 'test');
  const source = settings.getSources()[0];
  const headers = { ...requestHeaders, cookie };
  for (const remove of [false, true]) {
    if (remove) settings.deleteSource(source.id, 'test');
    else settings.setSourceEnabled(source.id, false, 'test');
    const identities = (await app.inject({ url: '/api/pricing', headers })).json()
      .models as PriceModelIdentity[];
    assert.equal(identities.find((model) => model.model === 'protected-model')?.fromLogs, true);
    assert.ok(!identities.some((model) => model.model === 'hidden-unpriced-model'));
    const before = snapshot(db);
    const renamed = await app.inject({
      url: '/api/pricing/models',
      method: 'PUT',
      headers,
      payload: {
        originalModel: 'protected-model',
        displayName: 'Test',
        priceId: price.id,
        price: { ...draft, model: 'renamed-model' },
      },
    });
    assert.equal(renamed.statusCode, 409);
    assert.equal(snapshot(db), before);
  }
});
