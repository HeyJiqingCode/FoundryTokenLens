import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { login, requestHeaders, testApp, testEmail, testPassword } from './helpers.js';

const eightCharacters = 'Eight8!x';

test('user creation and password changes accept eight characters and reject shorter or oversized passwords', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  for (const password of ['Seven7!', 'x'.repeat(129)]) {
    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { email: 'short@example.test', name: 'Short password', password, role: 'user' },
    });
    assert.equal(create.statusCode, 400);
    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers,
      payload: { currentPassword: testPassword, newPassword: password, revokeOtherSessions: true },
    });
    assert.equal(change.statusCode, 400);
  }
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: {
      email: 'eight@example.test',
      name: 'Eight character password',
      password: eightCharacters,
      role: 'user',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  await login(app, 'eight@example.test', eightCharacters);
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers,
    payload: {
      currentPassword: testPassword,
      newPassword: eightCharacters,
      revokeOtherSessions: true,
    },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  await login(app, testEmail, eightCharacters);
});

test('first-run administrator setup accepts an eight-character password', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-password-setup-'));
  const app = await buildApp({
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: join(directory, 'web'),
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const body = { email: testEmail, name: '管理员', password: 'Seven7!' };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/setup',
        headers: requestHeaders,
        payload: body,
      })
    ).statusCode,
    400,
  );
  const setup = await app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: requestHeaders,
    payload: { ...body, password: eightCharacters },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  await login(app, testEmail, eightCharacters);
});
