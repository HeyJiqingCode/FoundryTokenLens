import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { calculateCost, scopeKey } from '../src/server/pricing/engine.js';
import { hash } from '../src/server/ingestion/parser.js';
import { retailFamilyMatches } from '../src/shared/price-identity.js';
import type { RequestFact } from '../src/shared/ingestion.js';
import type { PriceInput, PriceVersion } from '../src/shared/settings.js';
import {
  modelPrices,
  modelSummary,
  periodLabel,
  versionStatus,
} from '../src/web/features/settings/prices/model-prices.js';
import { requestHeaders, testApp } from './helpers.js';

const fact: RequestFact = {
  resourceId: '/synthetic/resource',
  correlationId: 'a',
  time: '2026-09-20T00:00:00.000Z',
  timeSource: 'event',
  model: 'gpt-fixture',
  modelVersion: 'v1',
  region: 'East US 2',
  deployment: 'fixture',
  operation: 'create-response',
  inputTokens: '1000',
  outputTokens: '100',
  cachedTokens: '200',
  cacheWriteTokens: null,
  durationMs: 100,
  timeToFirstTokenMs: null,
  statusCode: 200,
  callerIp: null,
  hasUsage: true,
  hasRequest: true,
};
const draft: PriceInput = {
  model: fact.model!,
  modelVersion: '*',
  region: '*',
  deploymentType: '*',
  validFrom: '2026-09-01T00:00:00.000Z',
  validTo: null,
  notes: '',
  items: [{ key: 'input', label: 'Input', unitPriceUsd: '1', unitQuantity: 1000000 }],
};
function insertFact(db: ReturnType<typeof openDatabase>, source: string, value: RequestFact) {
  db.connection
    .prepare('INSERT INTO request_facts VALUES (?, ?, ?, ?, 1, ?, NULL, NULL)')
    .run(source, value.resourceId, value.correlationId, value.time, JSON.stringify(value));
}

test('unbounded prices persist, cover earlier and future logs, and yield to the next dated version', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const response = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: { ...draft, validFrom: null },
  });
  assert.equal(response.statusCode, 201, response.body);
  const baseline = response.json().price as PriceVersion;
  assert.equal(baseline.validFrom, null);
  for (const time of [
    '1900-01-01T00:00:00.000Z',
    '2026-09-22T00:00:00.000Z',
    '2100-01-01T00:00:00.000Z',
  ]) {
    assert.equal(calculateCost({ ...fact, time }, [baseline]).totalUsd, '0.0008');
  }
  const boundary = '2026-10-01T00:00:00.000Z';
  const next = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: { ...draft, validFrom: boundary, items: [{ ...draft.items[0], unitPriceUsd: '2' }] },
  });
  assert.equal(next.statusCode, 201, next.body);
  const prices = (await app.inject({ url: '/api/settings/prices', headers })).json()
    .prices as PriceVersion[];
  assert.equal(prices.find((p) => p.id === baseline.id)?.validTo, boundary);
  assert.equal(
    calculateCost({ ...fact, time: '2026-09-30T23:59:59.999Z' }, prices).totalUsd,
    '0.0008',
  );
  assert.equal(calculateCost({ ...fact, time: boundary }, prices).totalUsd, '0.0016');
  assert.equal(
    calculateCost({ ...fact, time: '2100-01-01T00:00:00.000Z' }, prices).totalUsd,
    '0.0016',
  );
  const models = modelPrices([], prices);
  assert.equal(models[0].prices.at(-1)?.validFrom, null);
  assert.deepEqual(modelSummary(models[0], '1900-01-01T00:00:00.000Z').bands[0].values.input, [
    '1',
  ]);
  assert.equal(versionStatus({ validFrom: null, validTo: null }), 'pricing.currentVersion');
  assert.match(periodLabel(null, null), /长期有效|Always valid/);
  const reopened = openDatabase(directory);
  try {
    assert.equal(
      reopened.connection
        .prepare<[string], { valid_from: string | null }>(
          'SELECT valid_from FROM price_versions WHERE id=?',
        )
        .get(baseline.id)?.valid_from,
      null,
    );
    assert.equal(reopened.connection.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    reopened.close();
  }
});

test('a backfilled unbounded version ends at the first dated version and duplicate starts are rejected', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const dated = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: draft,
  });
  assert.equal(dated.statusCode, 201);
  const overlapping = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: { ...draft, validFrom: null, validTo: '2026-12-01T00:00:00.000Z' },
  });
  assert.equal(overlapping.statusCode, 409);
  const baseline = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: { ...draft, validFrom: null },
  });
  assert.equal(baseline.statusCode, 201, baseline.body);
  assert.equal(baseline.json().price.validTo, dated.json().price.validFrom);
  const before = (await app.inject({ url: '/api/settings/prices', headers })).body;
  for (const body of [
    { ...draft, validFrom: null },
    { ...draft, validFrom: null, validTo: '2026-12-01T00:00:00.000Z' },
  ]) {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/settings/prices',
      headers,
      payload: body,
    });
    assert.equal(rejected.statusCode, 409);
  }
  assert.equal((await app.inject({ url: '/api/settings/prices', headers })).body, before);
  const { validFrom: _start, ...missingStart } = draft;
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: missingStart,
  });
  assert.equal(rejected.statusCode, 400);
});

test('changing between bounded and unbounded starts invalidates the whole affected history without touching logs', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const first = (
    await app.inject({ method: 'POST', url: '/api/settings/prices', headers, payload: draft })
  ).json().price as PriceVersion;
  const later = (
    await app.inject({
      method: 'POST',
      url: '/api/settings/prices',
      headers,
      payload: { ...draft, validFrom: '2026-10-01T00:00:00.000Z' },
    })
  ).json().price as PriceVersion;
  const db = openDatabase(directory);
  try {
    for (const [id, time, model] of [
      ['old', '1900-01-01T00:00:00.000Z', fact.model],
      ['current', fact.time, fact.model],
      ['later', '2026-11-01T00:00:00.000Z', fact.model],
      ['other', '1900-01-01T00:00:00.000Z', 'other-model'],
    ])
      insertFact(db, 'source', { ...fact, correlationId: id!, time: time!, model });
    const rawBefore = db.connection
      .prepare('SELECT * FROM request_facts ORDER BY correlation_id')
      .all();
    const seedCosts = () =>
      db.connection.exec(
        "INSERT OR REPLACE INTO request_costs SELECT source_key,resource_id,correlation_id,'{}',time FROM request_facts",
      );
    const remaining = () =>
      db.connection
        .prepare('SELECT correlation_id FROM request_costs ORDER BY correlation_id')
        .all();
    seedCosts();
    const unbounded = await app.inject({
      method: 'PATCH',
      url: `/api/settings/prices/${first.id}`,
      headers,
      payload: { items: first.items, notes: '', validFrom: null },
    });
    assert.equal(unbounded.statusCode, 200, unbounded.body);
    assert.equal(unbounded.json().price.validFrom, null);
    assert.deepEqual(remaining(), [{ correlation_id: 'later' }, { correlation_id: 'other' }]);
    const unchangedStart = await app.inject({
      method: 'PATCH',
      url: `/api/settings/prices/${first.id}`,
      headers,
      payload: { items: first.items, notes: 'keep null' },
    });
    assert.equal(unchangedStart.json().price.validFrom, null);
    const overlap = await app.inject({
      method: 'PATCH',
      url: `/api/settings/prices/${later.id}`,
      headers,
      payload: { items: later.items, notes: '', validFrom: null },
    });
    assert.equal(overlap.statusCode, 409);
    seedCosts();
    const bounded = await app.inject({
      method: 'PUT',
      url: '/api/pricing/models',
      headers,
      payload: {
        originalModel: draft.model,
        displayName: 'Fixture',
        priceId: first.id,
        price: { ...draft, validTo: later.validFrom },
      },
    });
    assert.equal(bounded.statusCode, 200, bounded.body);
    assert.deepEqual(remaining(), [{ correlation_id: 'later' }, { correlation_id: 'other' }]);
    seedCosts();
    const again = await app.inject({
      method: 'PUT',
      url: '/api/pricing/models',
      headers,
      payload: {
        originalModel: draft.model,
        displayName: 'Fixture',
        priceId: first.id,
        price: { ...draft, validFrom: null, validTo: later.validFrom },
      },
    });
    assert.equal(again.statusCode, 200, again.body);
    assert.deepEqual(remaining(), [{ correlation_id: 'later' }, { correlation_id: 'other' }]);
    assert.deepEqual(
      db.connection.prepare('SELECT * FROM request_facts ORDER BY correlation_id').all(),
      rawBefore,
    );
  } finally {
    db.close();
  }
});

test('unbounded prices respect explicit end dates and do not price logs missing request timestamps', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const saved = await app.inject({
    method: 'POST',
    url: '/api/pricing/models',
    headers,
    payload: {
      displayName: 'Historical price',
      price: { ...draft, validFrom: null, validTo: fact.time },
    },
  });
  assert.equal(saved.statusCode, 201, saved.body);
  const price = saved.json().price as PriceVersion;
  assert.equal(
    calculateCost({ ...fact, time: '1900-01-01T00:00:00.000Z' }, [price]).totalUsd,
    '0.0008',
  );
  assert.equal(calculateCost(fact, [price]).totalUsd, null);
  assert.equal(
    calculateCost({ ...fact, timeSource: 'ingestion' }, [{ ...price, validTo: null }]).status,
    'missing_time',
  );
});

test('editing effective dates moves a continuous boundary, invalidates both old and new periods, and rejects overlap atomically', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const create = async (validFrom: string, unitPriceUsd: string) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/prices',
      headers,
      payload: { ...draft, validFrom, items: [{ ...draft.items[0], unitPriceUsd }] },
    });
    assert.equal(response.statusCode, 201);
    return response.json().price as PriceVersion;
  };
  const first = await create(draft.validFrom!, '1');
  const second = await create('2026-10-01T00:00:00.000Z', '2');
  await create('2026-11-01T00:00:00.000Z', '3');
  const db = openDatabase(directory);
  try {
    for (const [id, time] of [
      ['before', '2026-09-10'],
      ['new', '2026-09-20'],
      ['old', '2026-10-15'],
      ['after', '2026-11-15'],
    ]) {
      const value = { ...fact, correlationId: id, time: `${time}T00:00:00.000Z` };
      insertFact(db, 'synthetic', value);
      db.connection
        .prepare('INSERT INTO request_costs VALUES (?, ?, ?, ?, ?)')
        .run('synthetic', fact.resourceId, id, '{}', value.time);
    }
    const corrected = await app.inject({
      method: 'PATCH',
      url: `/api/settings/prices/${second.id}`,
      headers,
      payload: {
        items: second.items,
        notes: 'Changed effective date',
        validFrom: '2026-09-15T08:00:00+08:00',
        validTo: null,
      },
    });
    assert.equal(corrected.statusCode, 200);
    assert.equal(corrected.json().price.validFrom, '2026-09-15T00:00:00.000Z');
    assert.equal(corrected.json().price.validTo, '2026-11-01T00:00:00.000Z');
    const prices = (await app.inject({ url: '/api/settings/prices', headers })).json()
      .prices as PriceVersion[];
    assert.equal(
      prices.find((price) => price.id === first.id)?.validTo,
      '2026-09-15T00:00:00.000Z',
    );
    assert.equal(calculateCost(fact, prices).totalUsd, '0.0016');
    assert.deepEqual(
      db.connection
        .prepare('SELECT correlation_id FROM request_costs ORDER BY correlation_id')
        .all(),
      [{ correlation_id: 'after' }, { correlation_id: 'before' }],
    );
    const before = JSON.stringify(prices);
    for (const dates of [
      { validFrom: '2026-09-01T00:00:00Z' },
      { validTo: '2026-12-01T00:00:00Z' },
      { validTo: '2026-09-01T00:00:00Z' },
      { validFrom: 'not-a-date' },
    ]) {
      const rejected = await app.inject({
        method: 'PATCH',
        url: `/api/settings/prices/${second.id}`,
        headers,
        payload: { items: second.items, notes: '', ...dates },
      });
      assert.ok([400, 409].includes(rejected.statusCode));
      assert.equal(
        JSON.stringify((await app.inject({ url: '/api/settings/prices', headers })).json().prices),
        before,
      );
    }
    assert.ok(
      db.logs.query({
        category: 'operation',
        search: 'price.adjust_boundary',
        limit: 100,
        offset: 0,
      }).total,
    );
  } finally {
    db.close();
  }
});

test('normalized log scopes combine counts without combining deployments; Retail prefill never changes prices or costs', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-price-management-'));
  const db = openDatabase(directory);
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const endpoint = 'https://synthetic.blob.core.windows.net';
  const source = hash(endpoint);
  settings.saveSource(
    { authMode: 'connection_string', containers: ['insights-logs-azureopenairequestusage'] },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic-only',
      endpoint,
      managedIdentityClientId: '',
    },
    {
      endpoint,
      accountName: 'synthetic',
      containers: [
        { name: 'insights-logs-azureopenairequestusage', category: 'usage', label: 'Usage' },
      ],
      verifiedAt: fact.time,
    },
    'qa',
  );
  insertFact(db, source, fact);
  insertFact(db, source, { ...fact, correlationId: 'b', region: 'eastus2' });
  insertFact(db, source, {
    ...fact,
    correlationId: 'c',
    deployment: 'other-deployment',
    time: '2026-09-10T00:00:00.000Z',
  });
  insertFact(db, 'other-source', { ...fact, correlationId: 'foreign' });
  const saved = settings.addPrice(draft, 'qa');
  let fail = false,
    empty = false,
    calls = 0;
  const pricing = createPricingService(db, settings, async (region) => {
    calls++;
    if (fail) throw new Error('synthetic secret should not escape');
    if (empty) return [];
    return ['fixture', 'unrelated'].flatMap((family) =>
      ['Inp', 'Opt'].map((direction) => ({
        currencyCode: 'USD',
        type: 'Consumption',
        tierMinimumUnits: 0,
        isPrimaryMeterRegion: true,
        productId: 'synthetic',
        productName: 'Azure OpenAI',
        skuName: `${family} ${direction} Gl`,
        meterName: `${family} ${direction} 1M Tokens`,
        unitOfMeasure: '1M',
        retailPrice: '2',
        effectiveStartDate: draft.validFrom,
        armRegionName: region,
        meterId: `${family}-${direction}`,
      })),
    );
  });
  t.after(async () => {
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const scopes = pricing.detected();
  assert.equal(scopes.length, 2);
  assert.equal(scopes.find((scope) => scope.deployment === 'fixture')?.requests, 2);
  assert.equal(
    scopes.find((scope) => scope.deployment === 'other-deployment')?.firstSeen,
    '2026-09-10T00:00:00.000Z',
  );
  assert.equal(new Set(scopes.map((scope) => scope.scopeKey)).size, 2);
  assert.ok(scopes.every((scope) => scope.region === 'eastus2'));
  const snapshot = () =>
    JSON.stringify(
      ['price_versions', 'request_costs', 'system_logs'].map((table) =>
        db.connection.prepare(`SELECT * FROM ${table}`).all(),
      ),
    );
  const beforePrefill = snapshot();
  const filled = await pricing.prefill('gpt-fixture');
  assert.equal(filled.length, 1);
  assert.equal(filled[0].prices.input, '2');
  assert.equal(filled[0].longPrices, null);
  calls = 0;
  const [first, repeated] = await Promise.all([
    pricing.prefill('gpt-fixture'),
    pricing.prefill('gpt-fixture'),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first, repeated);
  empty = true;
  assert.deepEqual(await pricing.prefill('gpt-fixture'), []);
  fail = true;
  await assert.rejects(
    pricing.prefill('gpt-fixture'),
    (error: Error) =>
      !error.message.includes('secret') && error.message === 'pricing.priceFetchFailed',
  );
  assert.equal(snapshot(), beforePrefill);
  assert.deepEqual(settings.listPrices(), [saved]);
  const models = modelPrices(pricing.detected(), settings.listPrices());
  assert.equal(models.length, 1);
  assert.equal(models[0].scopes.length, 2);
  assert.deepEqual(modelSummary(models[0], '2026-09-22T00:00:00.000Z').bands[0].values.input, [
    '1',
    '1',
  ]);
  assert.equal(scopeKey(fact), scopes.find((scope) => scope.deployment === 'fixture')?.scopeKey);

  settings.addPrice({ ...draft, validFrom: '2026-10-01T00:00:00.000Z' }, 'qa');
  settings.addPrice({ ...draft, model: 'other-model' }, 'qa');
  insertFact(db, source, { ...fact, model: 'other-model', correlationId: 'untouched' });
  pricing.recalculate();
  const beforeFacts = db.connection
    .prepare('SELECT * FROM request_facts ORDER BY source_key, correlation_id')
    .all();
  const unaffectedPrice = settings.listPrices().find((price) => price.model === 'other-model');
  const unaffectedCost = db.connection
    .prepare("SELECT * FROM request_costs WHERE correlation_id = 'untouched'")
    .get();
  const deleted = pricing.deleteModelPrices('GPT-FIXTURE', 'qa');
  assert.deepEqual(deleted, { prices: 2, costs: 3 });
  assert.deepEqual(
    db.connection.prepare('SELECT * FROM request_facts ORDER BY source_key, correlation_id').all(),
    beforeFacts,
  );
  assert.deepEqual(settings.listPrices(), [unaffectedPrice]);
  assert.deepEqual(
    db.connection.prepare("SELECT * FROM request_costs WHERE correlation_id = 'untouched'").get(),
    unaffectedCost,
  );
  pricing.recalculate();
  const readCost = () =>
    JSON.parse(
      (
        db.connection
          .prepare(
            'SELECT result_json FROM request_costs WHERE source_key = ? AND correlation_id = ?',
          )
          .get(source, fact.correlationId) as { result_json: string }
      ).result_json,
    );
  assert.equal(readCost().totalUsd, null);
  assert.equal(readCost().knownUsd, null);
  assert.equal(
    modelPrices(pricing.detected(), settings.listPrices(), pricing.state().excludedModels).some(
      (model) => model.name === fact.model,
    ),
    false,
  );
  assert.deepEqual(settings.excludedPriceModels(), ['gpt-fixture']);
  const reopened = openDatabase(directory);
  try {
    assert.deepEqual(
      createSettingsRepository(reopened, createSecretStore(directory)).excludedPriceModels(),
      ['gpt-fixture'],
    );
  } finally {
    reopened.close();
  }
  const refreshed = pricing.refreshModels('qa');
  assert.deepEqual(refreshed.excludedModels, []);
  assert.ok(
    modelPrices(refreshed.detected, settings.listPrices(), refreshed.excludedModels).some(
      (model) => model.name === fact.model,
    ),
  );
  assert.ok(settings.listPrices().every((price) => price.model !== fact.model));
  assert.equal(readCost().totalUsd, null);
  assert.deepEqual(
    db.connection.prepare('SELECT * FROM request_facts ORDER BY source_key, correlation_id').all(),
    beforeFacts,
  );
  pricing.deleteModelPrices(fact.model!, 'qa');
  const added = settings.addPrice(draft, 'qa');
  pricing.invalidateManual(added.model, added.validFrom, added.validTo);
  pricing.recalculate();
  assert.equal(readCost().totalUsd, '0.0008');
  assert.deepEqual(pricing.state().excludedModels, []);
  assert.ok(
    modelPrices(pricing.detected(), settings.listPrices(), pricing.state().excludedModels).some(
      (model) => model.name === fact.model,
    ),
  );
  assert.deepEqual(
    db.connection.prepare('SELECT * FROM request_facts ORDER BY source_key, correlation_id').all(),
    beforeFacts,
  );
});

test('Retail candidate matching preserves model size boundaries and recognizes dated model releases', () => {
  assert.equal(retailFamilyMatches('gpt-5.6-sol', '5.6 sol'), true);
  assert.equal(retailFamilyMatches('gpt-4o', 'gpt 4o 0806'), true);
  assert.equal(retailFamilyMatches('gpt-image-2', 'gpt img 2'), true);
  assert.equal(retailFamilyMatches('gpt-5.6', '5.6 sol'), false);
  assert.equal(retailFamilyMatches('gpt-4o', 'gpt 4o mini'), false);
});

test('price prefill requires an administrator and validates input before fetching', async (t) => {
  const { app, cookie } = await testApp(t);
  const request = { method: 'POST', url: '/api/pricing/prefill' } as const;
  const payload = { model: 'test', deploymentType: 'Standard' };
  assert.equal(
    (await app.inject({ ...request, headers: requestHeaders, payload })).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ ...request, headers: { ...requestHeaders, cookie }, payload })).statusCode,
    400,
  );
});

test('price deletion requires admin access, trusted origin and matching model confirmation', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const saved = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: draft,
  });
  assert.equal(saved.statusCode, 201);
  const url = '/api/pricing/models';
  const payload = { model: draft.model, confirmation: draft.model };
  assert.equal(
    (await app.inject({ method: 'DELETE', url, headers: requestHeaders, payload })).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers: { ...headers, origin: 'https://untrusted.example' },
        payload,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url,
        headers,
        payload: { ...payload, confirmation: 'another-model' },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: '/api/settings/prices', headers })).json().prices.length,
    1,
  );
  const removed = await app.inject({ method: 'DELETE', url, headers, payload });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().deleted.prices, 1);
  assert.equal(
    (await app.inject({ url: '/api/settings/prices', headers })).json().prices.length,
    0,
  );
  assert.deepEqual((await app.inject({ url: '/api/pricing', headers })).json().excludedModels, [
    draft.model,
  ]);
  assert.equal((await app.inject({ method: 'DELETE', url, headers, payload })).statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/pricing/models/refresh',
        headers: requestHeaders,
        payload: {},
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/pricing/models/refresh', headers, payload: {} }))
      .statusCode,
    200,
  );
  // A manually added model without log records is not rediscovered from logs.
  assert.deepEqual((await app.inject({ url: '/api/pricing', headers })).json().excludedModels, [
    draft.model,
  ]);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/settings/prices', headers, payload: draft }))
      .statusCode,
    201,
  );
  assert.deepEqual((await app.inject({ url: '/api/pricing', headers })).json().excludedModels, []);
});
