import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { parseRecord, mergeRequestRecords } from '../src/server/ingestion/parser.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import { INTERVALS } from '../src/shared/analytics.js';
import { bucketStart, nextBucket, chooseInterval } from '../src/shared/time-window.js';
import { mergeLogFields } from '../src/shared/log-fields.js';
import { dueTaskSlot } from '../src/server/ingestion/schedule.js';
import { SyntheticBlobReader, path, usage, response, resource } from './fixtures/diagnostics.js';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-refactor-')),
    db = openDatabase(directory),
    settings = createSettingsRepository(db, createSecretStore(directory)),
    reader = new SyntheticBlobReader();
  let now = new Date('2026-09-29T05:59:00Z');
  const source = settings.saveSource(
    { authMode: 'connection_string', containers: LOG_CONTAINERS.map((c) => c.name) },
    {
      authMode: 'connection_string',
      connectionString: 'fixture',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      accountName: 'fixture',
      endpoint: 'https://fixture.blob.core.windows.net',
      containers: [...LOG_CONTAINERS],
      verifiedAt: now.toISOString(),
    },
    'test',
  );
  let worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => now,
  );
  const analytics = createAnalyticsService(db, settings),
    pricing = createPricingService(db, settings);
  t.after(async () => {
    await worker.stop();
    await pricing.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    settings,
    source,
    reader,
    analytics,
    pricing,
    get worker() {
      return worker;
    },
    at: (time: string) => (now = new Date(time)),
    restart: async () => {
      await worker.stop();
      worker = createImportWorker(
        db,
        settings,
        () => reader,
        () => now,
      );
    },
    run: async () => {
      worker.request('scan');
      await worker.settled();
    },
  };
}

test('real 429 shape: zero-duration 200 is kept as evidence, substantive 429 drives status independent of arrival order', () => {
  const placeholder = parseRecord(
    JSON.stringify(response('throttled', 0, 200)),
    'requests',
    resource,
  )[0];
  const error = parseRecord(
    JSON.stringify({
      ...response('throttled', 5369, 429),
      properties: { modelName: 'fixture-model', promptTokens: 0, completionTokens: 0 },
    }),
    'requests',
    resource,
  )[0];
  for (const records of [
    [placeholder, error],
    [error, placeholder],
    [placeholder, error, placeholder],
  ]) {
    const fact = mergeRequestRecords(records);
    assert.equal(fact.statusCode, 429);
    assert.equal(fact.durationMs, 5369);
    assert.equal(fact.responseRecordCount, 2);
    assert.equal(fact.inputTokens, null);
    assert.equal(fact.linkState, 'response_only');
  }
  const conflict = parseRecord(
    JSON.stringify(response('throttled', 4000, 500)),
    'requests',
    resource,
  )[0];
  const merged = mergeRequestRecords([error, conflict]);
  assert.equal(merged.statusCode, null);
  assert.equal(merged.statusConflict, true);
  assert.equal(merged.durationMs, null);
});

test('a placeholder-only response takes its duration from the last token, or none without one', () => {
  const placeholder = parseRecord(
    JSON.stringify(response('placeholder', 0, 200)),
    'requests',
    resource,
  )[0];
  const timed = parseRecord(
    JSON.stringify(usage('placeholder', { timeToFirstTokenMs: 700, timeToLastTokenMs: 4200 })),
    'usage',
    resource,
  )[0];
  assert.equal(mergeRequestRecords([placeholder, timed]).durationMs, 4200);
  const alone = mergeRequestRecords([placeholder]);
  assert.equal(alone.responsePlaceholder, true);
  assert.equal(alone.durationMs, null);
});

test('calls are dated by their start, logged as ticks since 1970 or since year 1, else by the log time', () => {
  const started = Date.UTC(2026, 8, 20, 1, 59, 50);
  const record = (requestTime: number) =>
    parseRecord(
      JSON.stringify({
        ...response('started', 10000, 200),
        properties: { promptTokens: 120, completionTokens: 30, requestTime },
      }),
      'requests',
      resource,
    )[0];
  for (const ticks of [started * 1e4, (started + 62135596800000) * 1e4]) {
    const fact = mergeRequestRecords([record(ticks)]);
    assert.equal(fact.time, new Date(started).toISOString());
    assert.equal(fact.timeSource, 'start');
  }
  const unknown = mergeRequestRecords([record(0)]);
  assert.equal(unknown.time, response('started').time);
  assert.equal(unknown.timeSource, 'event');
});

test('late Usage enriches one request and billing, exact duplicate locations survive, RR quantities never supply usage', async (t) => {
  const f = fixture(t),
    r = response('later', 100, 200);
  f.reader.put(LOG_CONTAINERS[1].name, path(), [r, r]);
  await f.run();
  assert.equal(f.analytics.requests({}).total, 1);
  assert.equal(f.analytics.report({}).summary.inputTokens, null);
  assert.equal(f.analytics.requests({}).requests[0].inputTokens, null);
  assert.equal(
    (f.db.connection.prepare('SELECT count(*) n FROM record_locations').get() as { n: number }).n,
    2,
  );
  f.reader.put(LOG_CONTAINERS[0].name, path(), [
    usage('later', { promptTokens: 100, cachedTokens: 50, generatedTokens: 10 }),
  ]);
  await f.run();
  const row = f.analytics.requests({}).requests[0];
  assert.equal(row.linkState, 'linked');
  assert.equal(row.inputTokens, '100');
  assert.equal(f.analytics.report({}).summary.cacheRatio, 0.5);
  assert.equal(f.analytics.requests({}).total, 1);
  const evidence = f.worker.evidence(resource, 'later');
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((r) => r.raw && r.data));
  assert.equal(evidence.find((r) => r.category === 'requests')?.locations?.length, 2);
});

test('one isolated malformed row cannot hold back later blobs or the next window', async (t) => {
  const f = fixture(t);
  f.reader.put(
    LOG_CONTAINERS[0].name,
    path('02', '29'),
    JSON.stringify(usage('valid-first')) + '\n{bad json}\n',
  );
  f.at('2026-09-29T02:05:00Z');
  await f.run();
  assert.equal(f.worker.status().issueCount, 1);
  f.reader.put(LOG_CONTAINERS[0].name, path('03', '29'), [usage('later-window')]);
  f.at('2026-09-29T03:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 2);
  assert.equal(
    (
      f.db.connection
        .prepare('SELECT count(*) n FROM review_progress WHERE active_until IS NOT NULL')
        .get() as { n: number }
    ).n,
    0,
  );
  assert.equal(f.worker.status().issueCount, 1);
});

test('due review is persisted while a manual scan runs and is executed after restart without waiting another day', async (t) => {
  const f = fixture(t);
  const task = f.settings.saveTask(
    {
      ...taskDefaults('review'),
      name: 'Review',
      enabled: true,
      hour: 14,
      frequencyDays: 1,
      sourceIds: [f.source.id],
    },
    'test',
  );
  await f.worker.tick();
  let release!: () => void;
  f.reader.holdRead = new Promise<void>((r) => (release = r));
  f.reader.put(LOG_CONTAINERS[0].name, path('05', '29'), [usage('busy')]);
  f.worker.request('scan');
  while (!f.reader.reads.length) await new Promise(setImmediate);
  f.at('2026-09-29T06:00:20Z');
  await f.worker.tick();
  assert.equal(
    (f.db.connection.prepare('SELECT count(*) n FROM task_pending').get() as { n: number }).n,
    1,
  );
  f.at('2026-09-29T06:01:00Z');
  release();
  await f.worker.settled();
  await f.restart();
  f.at('2026-09-29T06:01:10Z');
  await f.worker.tick();
  assert.equal(
    (f.db.connection.prepare('SELECT count(*) n FROM task_pending').get() as { n: number }).n,
    0,
  );
  assert.equal(f.settings.listTasks().find((t) => t.id === task.id)?.executionCount, 1);
  assert.equal(f.worker.status().runs[0].mode, 'reconcile');
  await f.worker.tick();
  assert.equal(f.settings.listTasks()[0].executionCount, 1);
});

test('active scheduler uses deterministic wall-clock slots across DST and ignores duplicate instants', () => {
  const task = {
    ...taskDefaults('daily'),
    id: 'dst',
    name: 'DST',
    enabled: true,
    sourceIds: ['s'],
    updatedAt: '',
    timezone: 'America/New_York',
    nighttime: { intervalMinutes: 5 },
  };
  assert.equal(
    dueTaskSlot(task, new Date('2026-11-01T05:30:00Z')),
    dueTaskSlot(task, new Date('2026-11-01T06:30:00Z')),
  );
  assert.equal(dueTaskSlot(task, new Date('2026-11-01T06:31:00Z')), null);
});

test('all requested aggregation intervals preserve totals, half-open bounds, empty buckets, and cache weighting', async (t) => {
  const f = fixture(t);
  f.reader.put(LOG_CONTAINERS[0].name, path(), [
    {
      ...usage('small', { promptTokens: 100, cachedTokens: 0, generatedTokens: 10 }),
      time: '2026-09-20T00:00:00Z',
    },
    {
      ...usage('large', { promptTokens: 900, cachedTokens: 810, generatedTokens: 90 }),
      time: '2026-09-20T00:05:00Z',
    },
    { ...usage('excluded', { promptTokens: 1, cachedTokens: 0 }), time: '2026-09-20T01:00:00Z' },
  ]);
  await f.run();
  for (const interval of INTERVALS) {
    const report = f.analytics.report({
      from: '2026-09-20T00:00:00Z',
      to: '2026-09-20T01:00:00Z',
      interval,
      timezone: 'Asia/Shanghai',
    });
    assert.equal(report.summary.requests, 2);
    assert.equal(report.summary.cacheRatio, 0.81);
    assert.equal(
      report.timeline.reduce((n, r) => n + r.requests, 0),
      2,
    );
  }
  assert.equal(
    f.analytics.report({ from: '2026-09-20T00:00:00Z', to: '2026-09-20T01:00:00Z', interval: '1m' })
      .timeline.length,
    60,
  );
  assert.equal(
    f.analytics.requests({ from: '2026-09-20T00:05:00Z', to: '2026-09-20T01:00:00Z' }).total,
    1,
  );
  // Auto aims at about 30 points: 1h → 1m, 12h → 30m, 24h → 1h, 7d → 6h, 30d and longer → 1d.
  for (const [span, interval] of [
    [3600000, '1m'],
    [12 * 3600000, '30m'],
    [86400000, '1h'],
    [7 * 86400000, '6h'],
    [30 * 86400000, '1d'],
    [365 * 86400000, '1d'],
  ] as const)
    assert.equal(chooseInterval('auto', 0, span), interval);
  // Multi-hour buckets follow local wall-clock hours, also across DST changes.
  assert.equal(
    bucketStart('2026-09-20T01:30:00Z', '6h', 'Asia/Shanghai'),
    '2026-09-19T22:00:00.000Z',
  );
  assert.equal(
    bucketStart('2026-09-20T05:00:00Z', '12h', 'Asia/Shanghai'),
    '2026-09-20T04:00:00.000Z',
  );
  assert.equal(
    bucketStart('2026-11-01T06:30:00Z', '6h', 'America/New_York'),
    '2026-11-01T04:00:00.000Z',
  );
  assert.equal(
    nextBucket('2026-11-01T04:00:00Z', '6h', 'America/New_York'),
    '2026-11-01T11:00:00.000Z',
  );
  assert.equal(
    nextBucket('2026-03-08T05:00:00Z', '6h', 'America/New_York'),
    '2026-03-08T10:00:00.000Z',
  );
  assert.equal(
    bucketStart('2026-11-01T07:30:00Z', '1d', 'America/New_York'),
    '2026-11-01T04:00:00.000Z',
  );
  assert.equal(
    nextBucket('2026-11-01T04:00:00Z', '1d', 'America/New_York'),
    '2026-11-02T05:00:00.000Z',
  );
});

test('field view retains unknown, null, empty, scalar-array differences, and source-specific conflicts', () => {
  const result = mergeLogFields([
    {
      category: 'usage',
      data: {
        resourceId: 'same',
        properties: { promptTokens: [10], cachedTokens: 0, custom: null },
      },
    },
    {
      category: 'requests',
      data: {
        resourceId: 'same',
        properties: { promptTokens: 10, custom: '', unknown: { flag: false } },
      },
    },
  ]);
  assert.equal(result.find((f) => f.path === 'resourceId')?.values.length, 1);
  assert.equal(result.find((f) => f.path === 'properties.promptTokens')?.values.length, 2);
  assert.equal(result.find((f) => f.path === 'properties.custom')?.values.length, 2);
  assert.equal(result.find((f) => f.path === 'properties.unknown.flag')?.values[0].value, false);
});

test('an incomplete old tail retains its offset without blocking discovery of later time windows', async (t) => {
  const f = fixture(t),
    oldPath = path('02', '29');
  const content = JSON.stringify(usage('first')) + '\n' + '{"unfinished":';
  f.reader.put(LOG_CONTAINERS[0].name, oldPath, content);
  f.at('2026-09-29T02:05:00Z');
  await f.run();
  const offset = (
    f.db.connection.prepare('SELECT byte_offset FROM import_blobs WHERE name=?').get(oldPath) as {
      byte_offset: number;
    }
  ).byte_offset;
  f.reader.put(LOG_CONTAINERS[0].name, path('03', '29'), [usage('newer')]);
  f.at('2026-09-29T03:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 2);
  assert.equal(
    (
      f.db.connection.prepare('SELECT byte_offset FROM import_blobs WHERE name=?').get(oldPath) as {
        byte_offset: number;
      }
    ).byte_offset,
    offset,
  );
  f.reader.put(LOG_CONTAINERS[0].name, oldPath, content + 'true}\n');
  f.at('2026-09-29T04:05:00Z');
  await f.run();
  assert.equal(f.worker.status().pendingScans, 0);
});

test('a stalled download is reported as a read timeout and keeps the file for retry', async (t) => {
  const f = fixture(t),
    read = f.reader.read.bind(f.reader);
  f.reader.read = async () => {
    throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  };
  f.reader.put(LOG_CONTAINERS[0].name, path(), [usage('stalled')]);
  await f.run();
  const failed = f.db.connection
    .prepare('SELECT error, complete FROM import_blobs WHERE failures > 0')
    .get() as { error: string; complete: number };
  assert.equal(failed.error, '日志读取超时，下次扫描会从断点继续。');
  assert.equal(failed.complete, 0);
  f.reader.read = read;
  f.at('2026-09-20T03:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 1);
});

test('one failed download cannot prevent listing subsequent pages and later-window files', async (t) => {
  const f = fixture(t),
    failed = path('00', '29'),
    read = f.reader.read.bind(f.reader);
  f.reader.pageSize = 1;
  f.reader.read = async (...args) => {
    if (args[1] === failed) throw new Error('fixture unavailable');
    return read(...args);
  };
  for (let i = 0; i < 8; i++)
    f.reader.put(LOG_CONTAINERS[0].name, path(String(i).padStart(2, '0'), '29'), [
      usage('page-' + i),
    ]);
  f.at('2026-09-29T08:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 7);
  f.reader.put(LOG_CONTAINERS[0].name, path('09', '29'), [usage('next-window')]);
  f.at('2026-09-29T09:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 8);
  f.reader.read = read;
  f.at('2026-09-29T10:05:00Z');
  await f.run();
  assert.equal(f.analytics.requests({}).total, 9);
  assert.equal(f.worker.status().pendingScans, 0);
});

test('context class comes from the billing engine and filters every view', async (t) => {
  const f = fixture(t);
  f.reader.put(LOG_CONTAINERS[0].name, path(), [
    usage('context', { promptTokens: 100, generatedTokens: 10, cachedTokens: 50 }),
    usage('short', { promptTokens: 40, generatedTokens: 10, cachedTokens: 0 }),
    usage('flat', { modelName: 'flat-model', promptTokens: 900, generatedTokens: 10 }),
  ]);
  await f.run();
  const item = { key: 'input', label: 'Input', unitPriceUsd: '1', unitQuantity: 1000000 };
  const base = {
    model: 'synthetic-model',
    modelVersion: '*',
    region: '*',
    deploymentType: '*',
    validFrom: null,
    validTo: null,
    notes: '',
    items: [item],
  };
  f.settings.addPrice(
    { ...base, contextPricing: { threshold: '200', longItems: [{ ...item, unitPriceUsd: '2' }] } },
    'test',
  );
  f.settings.addPrice(
    {
      ...base,
      modelVersion: 'v1',
      contextPricing: { threshold: '50', longItems: [{ ...item, unitPriceUsd: '3' }] },
    },
    'test',
  );
  f.settings.addPrice({ ...base, model: 'flat-model' }, 'test');
  while (f.pricing.recalculate());
  const cost = (id: string) => f.analytics.requests({ requestId: id }).requests[0].cost;
  // 100 input tokens exceed the more specific v1 threshold of 50; 40 do not; flat-model has no tiers.
  assert.equal(cost('context')?.knownUsd, '0.00015');
  assert.equal(cost('context')?.context, 'long');
  assert.equal(cost('short')?.context, 'short');
  assert.equal(cost('flat')?.context, 'other');
  const bins = f.analytics.report({}).distributions?.context;
  assert.deepEqual(
    bins?.map((bin) => [bin.name, bin.count]),
    [
      ['short', 1],
      ['long', 1],
      ['other', 1],
    ],
  );
  for (const context of ['short', 'long', 'other'] as const) {
    const filtered = f.analytics.requests({ context });
    assert.equal(filtered.total, 1, context);
    assert.equal(filtered.requests[0].cost?.context, context);
    assert.equal(f.analytics.report({ context }).summary.requests, 1, context);
  }
});

test('scan discovers a later-created Usage container, backfills it and joins existing responses without changing schedules', async (t) => {
  const f = fixture(t),
    db = f.db.connection;
  const saved = JSON.parse(
    (
      db.prepare("SELECT value_json FROM settings WHERE key='sources'").get() as {
        value_json: string;
      }
    ).value_json,
  );
  saved[0].containers = [LOG_CONTAINERS[1].name];
  saved[0].availableContainers = [LOG_CONTAINERS[1]];
  db.prepare("UPDATE settings SET value_json=? WHERE key='sources'").run(JSON.stringify(saved));
  const original = f.reader.list.bind(f.reader);
  let outcome: 'missing' | 'denied' | 'exists' = 'missing';
  f.reader.list = async (...args) => {
    if (args[0] === LOG_CONTAINERS[0].name && outcome !== 'exists')
      throw Object.assign(new Error('fixture'), { statusCode: outcome === 'missing' ? 404 : 403 });
    return original(...args);
  };
  f.reader.put(LOG_CONTAINERS[1].name, path(), [response('discovered')]);
  await f.run();
  assert.equal(f.analytics.requests({}).requests[0].hasUsage, false);
  assert.deepEqual(f.settings.getSources()[0].containers, [LOG_CONTAINERS[1].name]);
  outcome = 'denied';
  f.at('2026-09-29T06:00:00Z');
  await f.run();
  assert.equal(f.worker.status().runs[0].status, 'partial');
  assert.deepEqual(f.settings.getSources()[0].containers, [LOG_CONTAINERS[1].name]);
  outcome = 'exists';
  f.at('2026-09-29T06:01:00Z');
  f.reader.put(LOG_CONTAINERS[0].name, path(), [usage('discovered')]);
  await f.run();
  assert.equal(f.analytics.requests({}).requests[0].linkState, 'linked');
  assert.equal(f.analytics.requests({}).total, 1);
  assert.deepEqual(
    new Set(f.settings.getSources()[0].containers),
    new Set(LOG_CONTAINERS.map((x) => x.name)),
  );
  assert.equal(f.settings.getSources()[0].updatedAt, saved[0].updatedAt);
  await f.restart();
  await f.run();
  assert.equal(f.analytics.requests({}).total, 1);
});
