import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { login, requestHeaders, setupAdmin, testPassword } from './helpers.js';

test('Entra configuration encrypts credentials and enables organization OAuth without ID-token shortcuts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-entra-'));
  const verified: string[] = [];
  const app = await buildApp(
    {
      host: '127.0.0.1',
      port: 8080,
      publicUrl: 'http://127.0.0.1:8080',
      dataDir: dir,
      webDir: dir,
    },
    false,
    {
      entraVerifier: async (tenant) => {
        verified.push(tenant);
      },
    },
  );
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const headers = { ...requestHeaders, cookie: await login(app) };
  const input = {
    enabled: true,
    allowedTenantIds: ['11111111-1111-4111-8111-111111111111'],
    clientId: '22222222-2222-4222-8222-222222222222',
    clientSecret: 'synthetic-entra-secret-only',
  };
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers,
    payload: input,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const statusOff = await app.inject({
    method: 'PATCH',
    url: '/api/settings/entra',
    headers,
    payload: { enabled: false },
  });
  assert.equal(statusOff.statusCode, 200);
  assert.equal(statusOff.json().entra.enabled, false);
  assert.equal(statusOff.json().entra.clientId, input.clientId);
  assert.equal(statusOff.json().entra.hasSecret, true);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/settings/entra',
        headers,
        payload: { enabled: true, clientId: 'unexpected' },
      })
    ).statusCode,
    400,
  );
  const on = await app.inject({
    method: 'PATCH',
    url: '/api/settings/entra',
    headers,
    payload: { enabled: true },
  });
  assert.equal(on.statusCode, 200);
  assert.equal(on.json().entra.enabled, true);
  assert.deepEqual(verified, [...input.allowedTenantIds, ...input.allowedTenantIds]);

  assert.equal(saved.json().entra.hasSecret, true);
  assert.equal(saved.body.includes(input.clientSecret), false);
  assert.equal(
    readFileSync(join(dir, 'foundry-token-lens.sqlite')).includes(input.clientSecret),
    false,
  );
  assert.deepEqual(verified, [...input.allowedTenantIds, ...input.allowedTenantIds]);
  assert.equal((await app.inject('/api/session')).json().entraEnabled, true);
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: requestHeaders,
    payload: { provider: 'microsoft', returnTo: '/settings/users' },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const url = new URL(signIn.json().url);
  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://127.0.0.1:8080/api/auth/callback/microsoft',
  );
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: requestHeaders,
        payload: { provider: 'microsoft', idToken: { token: 'fake' } },
      })
    ).statusCode,
    400,
  );
  const callback = await app.inject('/api/auth/callback/microsoft?code=fake&state=missing');
  assert.equal(callback.statusCode, 302);
  assert.equal((await app.inject({ url: '/api/users', headers })).json().users.length, 1);
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/settings/entra',
        headers,
        payload: {
          ...input,
          clientId: '33333333-3333-4333-8333-333333333333',
          clientSecret: '',
          useSavedSecret: true,
        },
      })
    ).statusCode,
    400,
  );
  const off = await app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers,
    payload: { ...input, enabled: false, clientSecret: '', useSavedSecret: true },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: requestHeaders,
        payload: { provider: 'microsoft' },
      })
    ).statusCode,
    409,
  );
});

test('an Entra administrator cannot replace the final local recovery administrator', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ftl-local-recovery-'));
  const app = await buildApp({
    host: '127.0.0.1',
    port: 8080,
    dataDir: dir,
    webDir: dir,
  });
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const headers = { ...requestHeaders, cookie: await login(app) };
  const local = (await app.inject({ url: '/api/session', headers })).json().user;
  const other = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: {
      email: 'external@example.test',
      name: 'Synthetic Entra',
      password: testPassword,
      role: 'admin',
    },
  });
  const db = openDatabase(dir);
  db.connection
    .prepare("UPDATE account SET providerId = 'microsoft', password = NULL WHERE userId = ?")
    .run(other.json().user.id);
  db.close();
  const denied = await app.inject({
    method: 'PATCH',
    url: `/api/users/${local.id}/access`,
    headers,
    payload: { role: 'user', enabled: true },
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().code, 'auth.initialLocalAdministratorSRoleCannotBeChanged');
});
