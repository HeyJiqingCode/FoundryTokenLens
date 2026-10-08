import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { login, requestHeaders, setupAdmin, testPassword } from './helpers.js';

test('setup runs once and a changed password survives restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-auth-test-'));
  const config = {
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: join(directory, 'web'),
  };
  let app = await buildApp(config);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await app.inject('/api/session')).json().setupRequired, true);
  const body = {
    email: 'admin@example.test',
    name: '管理员',
    password: testPassword,
    role: 'admin',
  };
  const results = await Promise.all(
    [1, 2].map(() =>
      app.inject({ method: 'POST', url: '/api/setup', headers: requestHeaders, payload: body }),
    ),
  );
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
  const cookie = await login(app);
  const newPassword = 'Changed-test-password-937!';
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: { ...requestHeaders, cookie },
    payload: { currentPassword: testPassword, newPassword, revokeOtherSessions: true },
  });
  assert.equal(changed.statusCode, 200);
  await app.close();
  app = await buildApp(config);
  assert.equal((await app.inject('/api/session')).json().setupRequired, false);
  const newCookie = await login(app, 'admin@example.test', newPassword);
  assert.equal(
    (await app.inject({ url: '/api/bootstrap', headers: { cookie: newCookie } })).statusCode,
    200,
  );
  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: requestHeaders,
    payload: { email: 'admin@example.test', password: testPassword },
  });
  assert.notEqual(oldLogin.statusCode, 200);
  const before = (await app.inject({ url: '/api/session', headers: { cookie: newCookie } })).json()
    .user;
  const renamed = await app.inject({
    method: 'POST',
    url: '/api/auth/update-user',
    headers: { ...requestHeaders, cookie: newCookie },
    payload: { name: 'Renamed Admin' },
  });
  assert.equal(renamed.statusCode, 200);
  const renamedCookie = await login(app, 'admin@example.test', newPassword);
  const after = (
    await app.inject({ url: '/api/session', headers: { cookie: renamedCookie } })
  ).json().user;
  assert.equal(after.id, before.id);
  assert.equal(after.name, 'Renamed Admin');
  assert.equal(after.email, 'admin@example.test');
});

test('moving the API port preserves sessions and uses the public preview origin for local aliases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-preview-origin-test-'));
  const config = {
    host: '127.0.0.1',
    port: 8080,
    publicUrl: 'http://127.0.0.1:8080',
    dataDir: directory,
    webDir: join(directory, 'web'),
  };
  let app = await buildApp(config);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const cookie = await login(app);
  const before = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  await app.close();
  app = await buildApp({ ...config, port: 8081 });
  const after = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  assert.equal(after.id, before.id);
  for (const origin of ['http://127.0.0.1:8080', 'http://localhost:8080']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: { ...requestHeaders, origin, cookie },
      payload: { name: 'Preview Admin' },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  for (const origin of [
    'http://localhost:8081',
    'http://localhost:5173',
    'https://untrusted.example',
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers: { ...requestHeaders, origin, cookie },
      payload: { name: 'Rejected change' },
    });
    assert.equal(response.statusCode, 403);
  }
});
