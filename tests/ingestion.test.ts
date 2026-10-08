import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createAnalyticsService } from '../src/server/analytics/service.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createPricingService } from '../src/server/pricing/service.js';
import { blobPath, parseRecord, token } from '../src/server/ingestion/parser.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import {
  SyntheticBlobReader,
  containers,
  usage,
  response,
  path,
  resource,
  now,
} from './fixtures/diagnostics.js';

function harness(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-ingestion-'));
  let db = openDatabase(dir);
  let settings = createSettingsRepository(db, createSecretStore(dir));
  const reader = new SyntheticBlobReader();
  let time = new Date(now);
  function saveSource(endpoint = 'https://synthetic.blob.core.windows.net') {
    settings.saveSource(
      { authMode: 'connection_string', containers },
      {
        authMode: 'connection_string',
        connectionString: 'synthetic-only',
        endpoint: '',
        managedIdentityClientId: '',
      },
      {
        endpoint,
        accountName: 'synthetic',
        containers: [...LOG_CONTAINERS],
        verifiedAt: now.toISOString(),
      },
      'synthetic-admin',
      settings.getSources()[0]?.id,
    );
  }
  saveSource();
  let worker = createImportWorker(
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
  return {
    reader,
    get analytics() {
      return createAnalyticsService(db, settings);
    },
    get db() {
      return db;
    },
    get settings() {
      return settings;
    },
    get worker() {
      return worker;
    },
    saveSource,
    advance(ms = 6000) {
      time = new Date(time.getTime() + ms);
    },
    async run(mode: 'scan' | 'reconcile' = 'scan') {
      worker.request(mode);
      await worker.settled();
    },
    async restart() {
      await worker.stop();
      db.close();
      db = openDatabase(dir);
      settings = createSettingsRepository(db, createSecretStore(dir));
      worker = createImportWorker(
        db,
        settings,
        () => reader,
        () => time,
      );
    },
  };
}

test('parser preserves int64, null vs zero, one-item arrays, nested properties, and resource scope', () => {
  const row = usage('r1', { cacheWriteTokens: 0 });
  const [parsed] = parseRecord(JSON.stringify(row), 'usage', resource);
  assert.equal(parsed.fact?.inputTokens, '120');
  assert.equal(parsed.fact?.cacheWriteTokens, '0');
  assert.equal(
    parseRecord(JSON.stringify(usage('r2')), 'usage', resource)[0].fact?.cacheWriteTokens,
    null,
  );
  const large = JSON.stringify({ ...row, properties: { promptTokens: 'REPLACE' } }).replace(
    '"REPLACE"',
    '9223372036854775807',
  );
  assert.equal(parseRecord(large, 'usage', resource)[0].fact?.inputTokens, '9223372036854775807');
  assert.equal(token('9223372036854775808'), null);
  assert.equal(token([1, 2]), null);
  assert.equal(token(-1), null);
  assert.throws(() => parseRecord(JSON.stringify(row), 'usage', `${resource}-other`));
  assert.equal(blobPath(path())?.resourceId, resource.toLowerCase());
  assert.equal(blobPath(path('28')), null);
});

test('Usage without event time imports using marked ingestion time, then joins RequestResponse time', async (t) => {
  const h = harness(t);
  const raw: Record<string, unknown> = usage('missing-time');
  delete raw.time;
  raw.FluentdIngestTimestamp = '2026-09-20T02:05:00.123456789Z';
  h.reader.put(containers[0], path(), [raw]);
  await h.run();
  assert.equal(h.analytics.requests({}, 10, 0).requests[0].timeSource, 'ingestion');
  assert.equal(h.worker.status().issueCount, 0);
  h.reader.put(containers[1], path(), [response('missing-time')]);
  await h.run();
  assert.equal(h.analytics.requests({}, 10, 0).requests[0].timeSource, 'event');
  assert.equal(h.analytics.requests({}, 10, 0).requests[0].time, now.toISOString());
});

test('usage and request logs join without double counting; all-zero failures survive', async (t) => {
  const h = harness(t);
  h.reader.put(containers[0], path(), [usage('r1'), usage('r1')]);
  h.reader.put(containers[1], path(), [
    response('r1'),
    response('r1', 0),
    response('failed', 0, 429),
    { ...response('management'), operationName: 'AccountListKeys', properties: {} },
  ]);
  await h.run();
  assert.equal(h.worker.status().requestCount, 2);
  const requests = h.analytics.requests({}, 50, 0).requests;
  const first = requests.find((x) => x.correlationId === 'r1')!;
  assert.equal(first.inputTokens, '120');
  assert.equal(first.durationMs, 100);
  assert.equal(first.hasUsage, true);
  assert.equal(first.hasRequest, true);
  assert.equal(first.cacheWriteTokens, null);
  assert.equal(requests.find((x) => x.correlationId === 'failed')?.statusCode, 429);
  assert.equal(requests.find((x) => x.correlationId === 'failed')?.inputTokens, null);
  const reads = h.reader.reads.length;
  await h.run('reconcile');
  assert.equal(h.reader.reads.length, reads, 'unchanged ETags do not redownload');
  assert.equal(h.worker.status().requestCount, 2);
  assert.equal(h.db.connection.pragma('integrity_check', { simple: true }), 'ok');
});

test('re-exported requests across files, reordered JSON, blob replacement and restart never add a second charge', async (t) => {
  const h = harness(t);
  h.settings.addPrice(
    {
      model: 'synthetic-model',
      modelVersion: '*',
      region: '*',
      deploymentType: '*',
      validFrom: null,
      validTo: null,
      notes: '',
      items: [
        { key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '2' },
        { key: 'cache_read', label: 'Cache read', unitQuantity: 1000000, unitPriceUsd: '0.2' },
        { key: 'output', label: 'Output', unitQuantity: 1000000, unitPriceUsd: '8' },
        { key: 'cache_write', label: 'Write', unitQuantity: 1000000, unitPriceUsd: '2.5' },
      ],
    },
    'test',
  );
  const original = usage('same-call', {
    promptTokens: [1000],
    cachedTokens: [200],
    generatedTokens: [100],
  });
  const changedOrder = Object.fromEntries(
    Object.entries({
      ...original,
      EnqueueTime: '2026-09-20T02:01:00.000Z',
      properties: JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(original.properties)).reverse()),
      ),
    }).reverse(),
  );
  // Same token counts do not establish the same request: this is a second call.
  const independent = { ...original, correlationId: 'independent-call' };
  h.reader.put(containers[0], path(), [original, original, independent]);
  h.reader.put(containers[0], path('03'), [{ records: [changedOrder, original] }]);
  h.reader.put(containers[1], path(), [
    response('same-call', 0),
    response('same-call', 100),
    response('independent-call'),
  ]);
  await h.run();
  let pricing = createPricingService(h.db, h.settings);
  pricing.recalculate();
  const before = h.analytics.requests({}, 10, 0).requests;
  assert.equal(before.length, 2);
  assert.deepEqual(
    before.map((r) => r.cost?.knownUsd),
    ['0.00244', '0.00244'],
  );
  assert.equal(before.find((r) => r.correlationId === 'same-call')?.durationMs, 100);

  h.reader.put(containers[0], path(), [independent, changedOrder, original], {
    blobType: 'BlockBlob',
  });
  await h.run('reconcile');
  pricing.recalculate();
  assert.equal(h.worker.status().requestCount, 2);
  assert.deepEqual(
    h.analytics.requests({}, 10, 0).requests.map((r) => r.cost?.knownUsd),
    ['0.00244', '0.00244'],
  );
  await pricing.stop();
  await h.restart();
  await h.run('reconcile');
  pricing = createPricingService(h.db, h.settings);
  pricing.recalculate();
  assert.equal(h.worker.status().requestCount, 2);
  assert.equal(
    (h.db.connection.prepare('SELECT count(*) n FROM request_costs').get() as { n: number }).n,
    2,
  );
  assert.deepEqual(
    h.analytics.requests({}, 10, 0).requests.map((r) => r.cost?.knownUsd),
    ['0.00244', '0.00244'],
  );
  await pricing.stop();
});

test('an 8 MiB read boundary and an ETag change never replay a partial line as another request', async (t) => {
  const h = harness(t);
  const chunkSize = 8 * 1024 * 1024;
  const first = JSON.stringify({ ...usage('first'), padding: '' });
  const padded =
    JSON.stringify({
      ...usage('first'),
      padding: 'x'.repeat(chunkSize - 80 - Buffer.byteLength(first) - 1),
    }) + '\n';
  assert.equal(Buffer.byteLength(padded), chunkSize - 80);
  const second = JSON.stringify(usage('second')) + '\n';
  h.reader.put(containers[0], path(), padded + second);
  await h.run();
  assert.equal(h.worker.status().requestCount, 2);
  const checkpoint = h.db.connection.prepare('SELECT byte_offset FROM import_blobs').get() as {
    byte_offset: number;
  };
  assert.equal(checkpoint.byte_offset, Buffer.byteLength(padded + second));
  await h.run();
  assert.equal(h.worker.status().requestCount, 2);
  assert.equal(h.reader.reads.at(-1)?.offset, Buffer.byteLength(padded));
  assert.equal(h.worker.status().pendingBlobs, 0);

  let release!: () => void;
  h.advance(3600000);
  h.reader.put(containers[0], path('03'), [usage('third')]);
  h.reader.holdRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.worker.request('scan');
  await new Promise((resolve) => setImmediate(resolve));
  h.reader.put(containers[0], path('03'), [usage('third'), usage('fourth')]);
  release();
  await h.worker.settled();
  assert.equal(h.worker.status().requestCount, 2);
  h.reader.holdRead = null;
  await h.run();
  assert.equal(h.worker.status().requestCount, 4);
  assert.equal(h.worker.status().issueCount, 0);
});

test('append resumes by byte offset; incomplete tails, retry, restart, and recreated blobs lose no requests', async (t) => {
  const h = harness(t);
  const first = JSON.stringify(usage('r1')) + '\n';
  h.reader.put(containers[0], path(), first + '{"time":');
  await h.run();
  assert.equal(h.worker.status().requestCount, 1);
  assert.equal(h.worker.status().pendingBlobs, 1);
  assert.equal(h.worker.status().runs[0].status, 'partial');
  await h.restart();
  h.reader.put(containers[0], path(), first + JSON.stringify(usage('r2')) + '\n');
  await h.run();
  assert.equal(h.reader.reads.at(-1)?.offset, Buffer.byteLength(first));
  assert.equal(h.worker.status().requestCount, 2);
  assert.equal(h.worker.status().pendingBlobs, 0);
  h.reader.put(containers[0], path(), [usage('r3'), usage('r4'), usage('r5')], {
    createdOn: '2026-09-20T01:00:00Z',
  });
  await h.run();
  assert.equal(h.reader.reads.at(-1)?.offset, 0, 'recreated append blob has a new generation');
  assert.equal(h.worker.status().requestCount, 5, 'previously imported history is retained');
  h.reader.put(containers[0], path(), [usage('r6')], { blobType: 'BlockBlob' });
  h.reader.failRead = true;
  await h.run();
  assert.equal(h.worker.status().requestCount, 5);
  assert.equal(h.worker.status().pendingBlobs, 1);
  assert.equal(JSON.stringify(h.worker.status()).includes('secret'), false);
  h.reader.failRead = false;
  await h.run();
  assert.equal(h.worker.status().requestCount, 6);
});

test('invalid complete lines are isolated and a second resource can reuse a correlation ID', async (t) => {
  const h = harness(t);
  h.reader.put(
    containers[0],
    path(),
    JSON.stringify(usage('same')) + '\nnot json\n' + JSON.stringify(usage('later')) + '\n',
  );
  const other = `${resource}-other`;
  h.reader.put(containers[0], path('02', '20', other), [usage('same', {}, other)]);
  await h.run();
  assert.equal(h.worker.status().requestCount, 3);
  assert.equal(h.worker.status().resourceCount, 2);
  assert.equal(h.worker.status().issueCount, 1);
  assert.equal(h.worker.status().issues[0].blobName, path());
  await h.run();
  assert.equal(h.worker.status().issueCount, 1);
});

test('record writes and byte checkpoints roll back together on a database failure', async (t) => {
  const h = harness(t);
  h.reader.put(containers[0], path(), [usage('good'), usage('simulate-db-failure')]);
  h.db.connection.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON diagnostic_records
    WHEN NEW.correlation_id = 'simulate-db-failure' BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
  await h.run();
  assert.equal(h.worker.status().requestCount, 0);
  assert.equal(h.worker.status().pendingBlobs, 1);
  assert.equal(
    (
      h.db.connection.prepare('SELECT byte_offset FROM import_blobs').get() as {
        byte_offset: number;
      }
    ).byte_offset,
    0,
  );
  h.db.connection.exec('DROP TRIGGER synthetic_failure');
  await h.run();
  assert.equal(h.worker.status().requestCount, 2);
  assert.equal(h.worker.status().pendingBlobs, 0);
});

test('paged discovery survives restart and imports old backlog beyond the review window', async (t) => {
  const h = harness(t);
  h.reader.pageSize = 1;
  for (let day = 1; day <= 10; day++)
    h.reader.put(containers[0], path('02', String(day).padStart(2, '0')), [usage(`old-${day}`)]);
  await h.run();
  assert.equal(h.worker.status().requestCount, 10);
  await h.restart();
  for (let i = 0; i < 6; i++) {
    h.advance();
    await h.worker.tick();
  }
  assert.equal(h.worker.status().requestCount, 10);
  assert.ok(h.reader.listings.some((x) => x.marker === '1'));
  assert.equal(h.worker.status().pendingBlobs, 0);
});

test('concurrent runs coalesce and changing data source cancels stale writes', async (t) => {
  const h = harness(t);
  h.reader.put(containers[0], path(), [usage('r1')]);
  let release!: () => void;
  h.reader.holdRead = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = h.worker.request('scan');
  const second = h.worker.request('reconcile');
  assert.equal(second.runId, first.runId);
  assert.equal(second.coalesced, true);
  await new Promise((resolve) => setImmediate(resolve));
  h.saveSource('https://replacement.blob.core.windows.net');
  release();
  await h.worker.settled();
  assert.equal(h.worker.status().requestCount, 0);
  const records = h.db.connection.prepare('SELECT count(*) AS n FROM diagnostic_records').get() as {
    n: number;
  };
  assert.equal(records.n, 0);
});

test('scheduler starts configured imports, combines review and scan, and stays idle within the interval', async (t) => {
  const h = harness(t);
  const sourceIds = [h.settings.getSources()[0].id];
  for (const type of ['daily', 'review'] as const)
    h.settings.saveTask({ ...taskDefaults(type), name: type, sourceIds }, 'test');
  h.reader.put(containers[0], path(), [usage('r1')]);
  await h.worker.tick();
  assert.equal(h.worker.status().requestCount, 1);
  assert.equal(h.worker.status().runs[0].trigger, 'scheduled');
  for (let i = 0; i < 3; i++) {
    h.advance();
    await h.worker.tick();
  }
  const runs = h.worker.status().runs.length;
  h.advance();
  await h.worker.tick();
  assert.equal(h.worker.status().runs.length, runs);
  h.advance(5 * 60000);
  await h.worker.tick();
  assert.equal(h.worker.status().runs.length, runs + 1);
});
