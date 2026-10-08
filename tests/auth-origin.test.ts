import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { readConfig, type AppConfig } from '../src/server/config.js';
import { microsoftCallbackUrl, normalizePublicUrl } from '../src/shared/public-url.js';
import { setupAdmin, testEmail, testPassword } from './helpers.js';

const entraInput = {
  enabled: true,
  allowedTenantIds: ['11111111-1111-4111-8111-111111111111'],
  clientId: '22222222-2222-4222-8222-222222222222',
  clientSecret: 'synthetic-entra-secret-only',
};
const mutationHeaders = (origin: string) => ({ origin, 'x-ftl-request': '1' });
async function loginAt(app: FastifyInstance, origin: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: mutationHeaders(origin),
    payload: { email: testEmail, password: testPassword },
  });
  assert.equal(response.statusCode, 200, response.body);
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies ?? ''])
    .map((value) => value.split(';')[0])
    .join('; ');
}

test('public URL accepts explicit origins and rejects paths, credentials and nonlocal plain HTTP', () => {
  assert.equal(normalizePublicUrl(' http://localhost:8080/ '), 'http://localhost:8080');
  assert.equal(normalizePublicUrl('https://LENS.example.test/'), 'https://lens.example.test');
  assert.equal(
    microsoftCallbackUrl('http://localhost:8080'),
    'http://localhost:8080/api/auth/callback/microsoft',
  );
  for (const invalid of [
    'http://lens.example.test',
    'http://localhost.evil.test',
    'https://user:password@lens.example.test',
    'https://lens.example.test/path',
    'https://lens.example.test/path/..',
    'https://lens.example.test?x=1',
    'https://lens.example.test#fragment',
    '//lens.example.test',
    'javascript:alert(1)',
    'https://lens.example.test\\evil',
    'http://[::1]:8080',
  ]) {
    assert.throws(() => normalizePublicUrl(invalid), Error, invalid);
  }
  assert.equal(
    readConfig({ FTL_PUBLIC_URL: 'https://lens.example.test/' }).publicUrl,
    'https://lens.example.test',
  );
  assert.equal(
    readConfig({ FTL_DEV_PUBLIC_URL: 'http://localhost:8080' }).defaultPublicUrl,
    'http://localhost:8080',
  );
});

test('saved public URL controls the callback, survives restart and preserves local sessions across loopback aliases', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-sso-origin-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8081,
    defaultPublicUrl: 'http://127.0.0.1:8080',
    dataDir: directory,
    webDir: directory,
  };
  let app = await buildApp(config, false, { entraVerifier: async () => {} });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const cookie = await loginAt(app, 'http://127.0.0.1:8080');
  const headers = { ...mutationHeaders('http://127.0.0.1:8080'), cookie };
  const before = (await app.inject({ url: '/api/session', headers })).json().user;
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers,
    payload: { ...entraInput, publicUrl: 'http://localhost:8080/' },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().entra.publicUrlSource, 'settings');
  assert.equal(saved.json().entra.callbackUrl, 'http://localhost:8080/api/auth/callback/microsoft');
  assert.equal(saved.body.includes(entraInput.clientSecret), false);
  const session = (await app.inject({ url: '/api/session', headers })).json();
  assert.equal(session.publicUrl, 'http://localhost:8080');
  assert.equal(session.user.id, before.id);
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: mutationHeaders('http://localhost:8080'),
    payload: { provider: 'microsoft' },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  assert.equal(
    new URL(signIn.json().url).searchParams.get('redirect_uri'),
    saved.json().entra.callbackUrl,
  );
  const wrongAlias = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: mutationHeaders('http://127.0.0.1:8080'),
    payload: { provider: 'microsoft' },
  });
  assert.equal(wrongAlias.statusCode, 409);
  assert.equal(wrongAlias.headers['set-cookie'], undefined);
  await app.close();
  app = await buildApp(config, false, { entraVerifier: async () => {} });
  const restarted = (await app.inject({ url: '/api/settings/entra', headers })).json().entra;
  assert.equal(restarted.publicUrl, 'http://localhost:8080');
  assert.equal(restarted.hasSecret, true);
  assert.equal((await app.inject({ url: '/api/session', headers })).json().user.id, before.id);
});

test('deployment URL overrides saved local settings and proxy headers cannot change the OAuth callback', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-sso-deployment-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: directory,
  };
  let app = await buildApp(config, false, { entraVerifier: async () => {} });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const cookie = await loginAt(app, 'http://localhost:8080');
  assert.equal(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/settings/entra',
        headers: { ...mutationHeaders('http://localhost:8080'), cookie },
        payload: { ...entraInput, publicUrl: 'http://localhost:8080' },
      })
    ).statusCode,
    200,
  );
  await app.close();
  const origin = 'https://lens.example.test';
  app = await buildApp({ ...config, host: '0.0.0.0', port: 8081, publicUrl: origin }, false, {
    entraVerifier: async () => {},
  });
  const deployedCookie = await loginAt(app, origin);
  const headers = { ...mutationHeaders(origin), cookie: deployedCookie };
  const setting = (await app.inject({ url: '/api/settings/entra', headers })).json().entra;
  assert.equal(setting.publicUrl, origin);
  assert.equal(setting.publicUrlSource, 'environment');
  const override = await app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers,
    payload: { ...entraInput, publicUrl: 'https://other.example.test' },
  });
  assert.equal(override.statusCode, 409);
  const auth = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/social',
    headers: {
      ...mutationHeaders(origin),
      host: 'internal:8081',
      'x-forwarded-host': 'evil.example.test',
      'x-forwarded-proto': 'http',
    },
    payload: { provider: 'microsoft', returnTo: '/analysis/tokens' },
  });
  assert.equal(auth.statusCode, 200, auth.body);
  assert.equal(
    new URL(auth.json().url).searchParams.get('redirect_uri'),
    `${origin}/api/auth/callback/microsoft`,
  );
  assert.match(String(auth.headers['set-cookie']), /Secure/);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: mutationHeaders('https://evil.example.test'),
        payload: { provider: 'microsoft' },
      })
    ).statusCode,
    403,
  );
});

test('local defaults use localhost and validate saved public URL before changing configuration', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-sso-default-'));
  const app = await buildApp(
    {
      host: '127.0.0.1',
      port: 8080,
      dataDir: directory,
      webDir: directory,
    },
    false,
    { entraVerifier: async () => {} },
  );
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await setupAdmin(app);
  const cookie = await loginAt(app, 'http://localhost:8080');
  const headers = { ...mutationHeaders('http://localhost:8080'), cookie };
  const before = (await app.inject({ url: '/api/settings/entra', headers })).json().entra;
  assert.equal(before.publicUrl, 'http://localhost:8080');
  assert.equal(before.publicUrlSource, 'default');
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers,
    payload: { ...entraInput, publicUrl: 'http://untrusted.example.test' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(
    (await app.inject({ url: '/api/settings/entra', headers })).json().entra,
    before,
  );
});

const firstAdmin = { email: testEmail, name: 'Administrator', password: testPassword };
const signInAt = (app: FastifyInstance, origin: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: mutationHeaders(origin),
    payload: { email: testEmail, password: testPassword },
  });

test('first setup records the address a deployment was opened at until FTL_PUBLIC_URL replaces it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-first-setup-'));
  const config: AppConfig = { host: '0.0.0.0', port: 8080, dataDir: directory, webDir: directory };
  let app = await buildApp(config);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal((await app.inject('/api/session')).json().setupRequired, true);
  const setup = (origin: string) =>
    app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: mutationHeaders(origin),
      payload: firstAdmin,
    });
  const plain = await setup('http://lens.example.test');
  assert.equal(plain.statusCode, 400);
  assert.equal(plain.json().code, 'auth.useHTTPSForHostedDeployments');
  assert.equal((await app.inject('/api/session')).json().setupRequired, true);

  const origin = 'https://lens.example.test';
  const created = await setup(origin);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal((await setup('https://other.example.test')).statusCode, 403);
  assert.equal((await setup(origin)).statusCode, 409);
  assert.equal((await app.inject('/api/session')).json().publicUrl, origin);
  const cookie = await loginAt(app, origin);
  const entra = (await app.inject({ url: '/api/settings/entra', headers: { cookie } })).json()
    .entra;
  assert.equal(entra.publicUrlSource, 'settings');
  assert.equal(entra.callbackUrl, `${origin}/api/auth/callback/microsoft`);
  assert.equal((await signInAt(app, 'http://localhost:8080')).statusCode, 403);

  await app.close();
  app = await buildApp(config);
  assert.equal((await app.inject('/api/session')).json().publicUrl, origin);
  await app.close();
  const moved = 'https://lens-new.example.test';
  app = await buildApp({ ...config, publicUrl: moved });
  assert.equal((await app.inject('/api/session')).json().publicUrl, moved);
  await loginAt(app, moved);
  assert.equal((await signInAt(app, origin)).statusCode, 403);
});

test('a deployment URL decides where first setup is accepted', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-fixed-setup-'));
  const origin = 'https://lens.example.test';
  const app = await buildApp({
    host: '0.0.0.0',
    port: 8080,
    publicUrl: origin,
    dataDir: directory,
    webDir: directory,
  });
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const setup = (from: string) =>
    app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: mutationHeaders(from),
      payload: firstAdmin,
    });
  assert.equal((await setup('https://other.example.test')).statusCode, 403);
  assert.equal((await setup(origin)).statusCode, 201);
  const cookie = await loginAt(app, origin);
  const entra = (await app.inject({ url: '/api/settings/entra', headers: { cookie } })).json()
    .entra;
  assert.equal(entra.publicUrl, origin);
  assert.equal(entra.publicUrlSource, 'environment');
});
