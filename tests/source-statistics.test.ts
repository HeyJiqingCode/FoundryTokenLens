import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createSecretStore } from '../src/server/security/secrets.js';
import { createSettingsRepository } from '../src/server/settings/repository.js';
import { createImportWorker } from '../src/server/ingestion/worker.js';
import { createSourceStatistics } from '../src/server/settings/source-statistics.js';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import { SyntheticBlobReader } from './fixtures/diagnostics.js';

test('source totals persist across restarts, reads avoid Blob, refreshes coalesce, and scheduled runs update SQLite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-source-statistics-'));
  const db = openDatabase(directory);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const settings = createSettingsRepository(db, createSecretStore(directory));
  const containers = LOG_CONTAINERS.slice(0, 2).map((item) => item.name);
  const source = settings.saveSource(
    { authMode: 'connection_string', containers, enabled: false },
    {
      authMode: 'connection_string',
      connectionString: 'synthetic',
      endpoint: '',
      managedIdentityClientId: '',
    },
    {
      endpoint: 'https://synthetic.blob.core.windows.net',
      accountName: 'synthetic',
      containers: [...LOG_CONTAINERS],
      verifiedAt: new Date().toISOString(),
    },
    'test',
  );
  const reader = new SyntheticBlobReader();
  reader.pageSize = 1;
  reader.put(containers[0], 'old/unparsed-file', '123');
  reader.put(containers[0], 'new/unparsed-file', '12345');
  reader.put(containers[1], 'another-resource/unparsed-file', '1234567');
  reader.put('unselected-container', 'unselected', 'ignored');
  let clock = 1000;
  const statistics = createSourceStatistics(
    db,
    settings,
    () => reader,
    () => clock,
  );
  assert.equal(statistics.read(source.id), null);
  assert.equal(reader.listings.length, 0);
  const [first, concurrent] = await Promise.all([
    statistics.refresh(source.id),
    statistics.refresh(source.id),
  ]);
  assert.deepEqual(first, { files: 3, bytes: '15', checkedAt: new Date(clock).toISOString() });
  assert.deepEqual(first, concurrent);
  assert.equal(reader.listings.length, 3);
  assert.equal(reader.reads.length, 0);
  assert.ok(reader.listings.every((listing) => listing.prefix === ''));
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM import_blobs').get() as { n: number }).n,
    0,
  );
  reader.put(containers[0], 'new/unparsed-file', '1234567890');
  reader.blobs.delete(`${containers[1]}/another-resource/unparsed-file`);
  assert.deepEqual(statistics.read(source.id), first);
  assert.equal(reader.listings.length, 3);
  const reopened = openDatabase(directory);
  assert.deepEqual(createSourceStatistics(reopened, settings, () => reader).read(source.id), first);
  reopened.close();
  clock += 60001;
  assert.deepEqual(await statistics.refresh(source.id), {
    files: 2,
    bytes: '13',
    checkedAt: new Date(clock).toISOString(),
  });
  const list = reader.list.bind(reader);
  reader.list = async (...args) => {
    if (args[0] === containers[1]) throw new Error('secret must not escape');
    return list(...args);
  };
  clock += 60001;
  await assert.rejects(statistics.refresh(source.id), {
    statusCode: 502,
    message: 'sources.statisticsFailed',
  });
  assert.equal(statistics.read(source.id)?.bytes, '13');
  reader.list = list;
  clock += 60001;
  assert.equal((await statistics.refresh(source.id)).files, 2);
  settings.setSourceEnabled(source.id, true, 'test');
  settings.saveTask({ ...taskDefaults('daily'), name: 'Routine', sourceIds: [source.id] }, 'test');
  clock += 60001;
  const beforeRun = reader.listings.length;
  const worker = createImportWorker(
    db,
    settings,
    () => reader,
    () => new Date('2026-09-26T04:00:00Z'),
    statistics.refresh,
  );
  await worker.tick();
  await worker.settled();
  assert.ok(reader.listings.length > beforeRun);
  assert.equal(statistics.read(source.id)?.checkedAt, new Date(clock).toISOString());
  await worker.stop();
  await statistics.stop();
  settings.deleteSource(source.id, 'test');
  assert.equal(
    (db.connection.prepare('SELECT count(*) n FROM source_statistics').get() as { n: number }).n,
    0,
  );
  assert.throws(() => statistics.refresh(source.id), {
    statusCode: 404,
    message: 'sources.sourceNotFound',
  });
});
