import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { LOG_CONTAINERS } from '../src/shared/settings.js';
import {
  azureBlobInspector,
  normalizeManagedIdentityEndpoint,
} from '../src/server/sources/azure-blob.js';
import { azureBlobReader } from '../src/server/ingestion/blob-reader.js';
import type { HttpError } from '../src/server/http/errors.js';
import { path, containers, usage } from './fixtures/diagnostics.js';

test('actual Azure SDK probes the diagnostic containers over a local synthetic Blob protocol fixture', async (t) => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    assert.match(request.headers.authorization ?? '', /^SharedKey fixtureacct:/);
    response.setHeader('x-ms-request-id', 'synthetic-fixture');
    response.setHeader('x-ms-version', '2023-11-03');
    const url = new URL(request.url!, 'http://localhost');
    if (url.searchParams.get('comp') !== 'list') {
      response.writeHead(200);
      response.end();
      return;
    }
    const container = url.pathname.split('/').at(-1);
    response.setHeader('Content-Type', 'application/xml');
    response.end(
      `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://localhost" ContainerName="${container}"><Prefix/><Marker/><MaxResults>1</MaxResults><Blobs/><NextMarker/></EnumerationResults>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as AddressInfo).port;
  const key = Buffer.alloc(64, 7).toString('base64');
  const result = await azureBlobInspector.inspect({
    authMode: 'connection_string',
    endpoint: '',
    managedIdentityClientId: '',
    connectionString: `DefaultEndpointsProtocol=http;AccountName=fixtureacct;AccountKey=${key};BlobEndpoint=http://127.0.0.1:${port}/fixtureacct;`,
  });
  assert.equal(result.accountName, 'fixtureacct');
  assert.deepEqual(
    result.containers.map((item) => item.name),
    LOG_CONTAINERS.map((item) => item.name),
  );
  assert.equal(calls.filter((call) => !call.includes('comp=list')).length, 2);
  assert.equal(calls.filter((call) => call.includes('comp=list')).length, 2);
  assert.equal(
    calls.every((call) => call.startsWith('GET')),
    true,
  );
  assert.equal(JSON.stringify(result).includes(key), false);
});

async function inspectDenied(t: TestContext, errorCode: string) {
  const server = createServer((_request, response) => {
    response.setHeader('x-ms-request-id', 'synthetic-fixture');
    response.setHeader('x-ms-version', '2023-11-03');
    response.setHeader('x-ms-error-code', errorCode);
    response.setHeader('Content-Type', 'application/xml');
    response.writeHead(403);
    response.end(
      `<?xml version="1.0" encoding="utf-8"?><Error><Code>${errorCode}</Code><Message>Denied.</Message></Error>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as AddressInfo).port;
  const error = await azureBlobInspector
    .inspect({
      authMode: 'connection_string',
      endpoint: '',
      managedIdentityClientId: '',
      connectionString: `DefaultEndpointsProtocol=http;AccountName=fixtureacct;AccountKey=${Buffer.alloc(64, 7).toString('base64')};BlobEndpoint=http://127.0.0.1:${port}/fixtureacct;`,
    })
    .then(
      () => assert.fail('inspection should be denied'),
      (reason: unknown) => reason,
    );
  return (error as HttpError).body.code;
}

test('a signed-in identity without a Blob data role is told which role to assign', async (t) => {
  assert.equal(
    await inspectDenied(t, 'AuthorizationPermissionMismatch'),
    'sources.blobDataPermissionMissing',
  );
  assert.equal(await inspectDenied(t, 'AuthorizationFailure'), 'sources.containerAccessFailed');
});

test('managed identity tokens cannot be directed to arbitrary endpoints', () => {
  for (const url of [
    'http://fixtureacct.blob.core.windows.net',
    'https://example.com',
    'https://fixtureacct.blob.core.windows.net.evil.example',
    'https://fixtureacct.blob.core.windows.net?sig=secret',
  ]) {
    assert.throws(() => normalizeManagedIdentityEndpoint(url));
  }
  assert.equal(
    normalizeManagedIdentityEndpoint('https://fixtureacct.blob.core.windows.net/'),
    'https://fixtureacct.blob.core.windows.net',
  );
});

test('actual SDK paginates inventory and uses If-Match and byte ranges for downloads', async (t) => {
  const body = Buffer.from(JSON.stringify(usage('sdk-r1')) + '\n');
  const requests: { path: string; range: string | undefined; match: string | undefined }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({
      path: request.url!,
      range: (request.headers['x-ms-range'] as string | undefined) ?? request.headers.range,
      match: request.headers['if-match'],
    });
    response.setHeader('x-ms-request-id', 'synthetic-fixture');
    response.setHeader('x-ms-version', '2023-11-03');
    if (url.searchParams.get('comp') === 'list') {
      response.setHeader('Content-Type', 'application/xml');
      response.end(
        `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://localhost" ContainerName="${containers[0]}"><Blobs><Blob><Name>${path()}</Name><Properties><Creation-Time>Sun, 20 Sep 2026 00:00:00 GMT</Creation-Time><Last-Modified>Sun, 20 Sep 2026 02:00:00 GMT</Last-Modified><Etag>\"fixture-etag\"</Etag><Content-Length>${body.length}</Content-Length><BlobType>AppendBlob</BlobType></Properties></Blob></Blobs><NextMarker>${url.searchParams.get('marker') ? '' : 'next-fixture'}</NextMarker></EnumerationResults>`,
      );
      return;
    }
    if (request.headers['if-match'] !== '"fixture-etag"') {
      response.writeHead(412, { 'Content-Type': 'application/xml' });
      response.end(
        '<Error><Code>ConditionNotMet</Code><Message>Synthetic ETag mismatch</Message></Error>',
      );
      return;
    }
    const range = String(request.headers['x-ms-range'] ?? request.headers.range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(match[1]),
      end = Number(match[2]);
    response.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      etag: '"fixture-etag"',
    });
    response.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const reader = azureBlobReader({
    authMode: 'connection_string',
    endpoint: '',
    managedIdentityClientId: '',
    connectionString: `DefaultEndpointsProtocol=http;AccountName=fixtureacct;AccountKey=${Buffer.alloc(64, 7).toString('base64')};BlobEndpoint=http://127.0.0.1:${(server.address() as AddressInfo).port}/fixtureacct;`,
  });
  const signal = AbortSignal.timeout(5000);
  const first = await reader.list(containers[0], '', undefined, signal);
  assert.equal(first.marker, 'next-fixture');
  assert.equal(first.items[0].createdOn, '2026-09-20T00:00:00.000Z');
  assert.equal(first.items[0].blobType, 'AppendBlob');
  assert.equal((await reader.list(containers[0], '', first.marker!, signal)).marker, null);
  assert.deepEqual(
    await reader.read(containers[0], path(), 7, 12, '"fixture-etag"', signal),
    body.subarray(7, 19),
  );
  assert.equal(requests.at(-1)?.range, 'bytes=7-18');
  await assert.rejects(
    reader.read(containers[0], path(), 0, 12, '"stale"', signal),
    (error: unknown) => (error as { statusCode?: number }).statusCode === 412,
  );
});
