import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { testApp } from './helpers.js';

test('responses are compressed for clients that accept it, and only then', async (t) => {
  const { app, cookie } = await testApp(t);
  // Two days by the hour: a report well past the size worth compressing.
  const url = '/api/analytics?interval=1h&from=2026-09-01T00:00:00Z&to=2026-09-03T00:00:00Z';
  const plain = await app.inject({ url, headers: { cookie } });
  const packed = await app.inject({ url, headers: { cookie, 'accept-encoding': 'gzip' } });
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.ok(packed.rawPayload.length * 3 < plain.rawPayload.length);
  assert.deepEqual(JSON.parse(gunzipSync(packed.rawPayload).toString('utf8')), plain.json());
});
