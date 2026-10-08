import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { login, origin, requestHeaders, setupAdmin, testPassword } from './helpers.js';

const home = '11111111-1111-4111-8111-111111111111';
const partner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const outsider = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const objectId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const clientId = '22222222-2222-4222-8222-222222222222';
const initial = {
  enabled: true,
  allowedTenantIds: [home],
  clientId,
  clientSecret: 'synthetic-entra-test-secret',
};
const cookies = (value: string[] | string | undefined) =>
  (Array.isArray(value) ? value : [value ?? '']).map((item) => item.split(';')[0]).join('; ');

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-entra-multi-'));
  const verified: string[] = [];
  const config = {
    host: '127.0.0.1',
    port: 8080,
    publicUrl: origin,
    dataDir: directory,
    webDir: directory,
  };
  const app = await buildApp(config, false, {
    entraVerifier: async (tenant) => {
      verified.push(tenant);
    },
  });
  await setupAdmin(app);
  const db = openDatabase(directory);
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = { ...requestHeaders, cookie: await login(app) };
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'synthetic-key',
    use: 'sig',
    issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
  };
  let tokenClaims: Record<string, unknown> = {};
  let corruptSignature = false;
  const network: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    network.push(url.href);
    assert.equal(url.origin, 'https://login.microsoftonline.com');
    if (url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] });
    assert.ok(url.pathname.endsWith('/oauth2/v2.0/token'), url.href);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode(tokenClaims)}`;
    const signature = corruptSignature
      ? Buffer.alloc(256)
      : sign('RSA-SHA256', Buffer.from(content), privateKey);
    return Response.json({
      token_type: 'Bearer',
      access_token: 'synthetic-access-token',
      expires_in: 3600,
      id_token: `${content}.${signature.toString('base64url')}`,
    });
  });
  async function save(extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'PUT',
      url: '/api/settings/entra',
      headers,
      payload: { ...initial, ...extra },
    });
  }
  let loginSequence = 0;
  async function start() {
    const remoteAddress = `192.0.2.${++loginSequence}`;
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social',
      remoteAddress,
      headers: requestHeaders,
      payload: { provider: 'microsoft', returnTo: '/requests' },
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      url: new URL(response.json().url),
      cookie: cookies(response.headers['set-cookie']),
      remoteAddress,
    };
  }
  async function finish(
    flow: Awaited<ReturnType<typeof start>>,
    tenant: string,
    overrides: Record<string, unknown> = {},
    tamper = false,
  ) {
    const now = Math.floor(Date.now() / 1000);
    tokenClaims = {
      iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
      aud: clientId,
      tid: tenant,
      oid: objectId,
      sub: `${tenant}-${objectId}`,
      name: 'Synthetic Organization User',
      preferred_username: 'same@example.test',
      iat: now,
      nbf: now - 1,
      exp: now + 3600,
      nonce: flow.url.searchParams.get('nonce'),
      ...overrides,
    };
    corruptSignature = tamper;
    return app.inject({
      url: `/api/auth/callback/microsoft?code=synthetic&state=${flow.url.searchParams.get('state')}`,
      headers: { cookie: flow.cookie },
      remoteAddress: flow.remoteAddress,
    });
  }
  async function session(response: Awaited<ReturnType<typeof finish>>) {
    return (
      await app.inject({
        url: '/api/session',
        headers: { cookie: cookies(response.headers['set-cookie']) },
      })
    ).json();
  }
  return { app, db, headers, config, verified, network, jwk, save, start, finish, session };
}

test('one tenant and multiple tenants use the same organizations flow with a required normalized allowlist', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save()).statusCode, 200);
  let settings = (await f.app.inject({ url: '/api/settings/entra', headers: f.headers })).json()
    .entra;
  assert.equal(Object.hasOwn(settings, 'tenantMode'), false);
  assert.deepEqual(settings.allowedTenantIds, [home]);
  assert.equal((await f.start()).url.pathname, '/organizations/oauth2/v2.0/authorize');
  const saved = await f.save({
    allowedTenantIds: [partner.toUpperCase(), partner],
    clientSecret: '',
    useSavedSecret: true,
  });
  assert.equal(saved.statusCode, 200, saved.body);
  settings = saved.json().entra;
  assert.deepEqual(settings.allowedTenantIds, [partner]);
  assert.equal(settings.hasSecret, true);
  const flow = await f.start();
  assert.equal(flow.url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(flow.url.searchParams.get('scope'), 'openid profile email');
  assert.ok(flow.url.searchParams.get('state'));
  assert.ok(flow.url.searchParams.get('nonce'));
  assert.equal(flow.url.searchParams.get('redirect_uri'), `${origin}/api/auth/callback/microsoft`);
  assert.deepEqual(f.verified, [home, partner]);
  for (const extra of [
    { allowedTenantIds: [] },
    { allowedTenantIds: undefined },
    { allowedTenantIds: ['organizations'] },
    { allowedTenantIds: ['https://untrusted.test'] },
    { allowedTenantIds: ['9188040d-6c67-4c5b-b112-36a304b66dad'] },
    { allowedTenantIds: Array(21).fill(partner) },
  ])
    assert.equal((await f.save(extra)).statusCode, 400);
  assert.deepEqual(
    (await f.app.inject({ url: '/api/settings/entra', headers: f.headers })).json().entra,
    settings,
  );
  const stored = JSON.parse(
    (
      f.db.connection.prepare("SELECT value_json FROM settings WHERE key='entra'").get() as {
        value_json: string;
      }
    ).value_json,
  );
  assert.equal(Object.hasOwn(stored, 'tenantMode'), false);
  assert.deepEqual(stored.allowedTenantIds, [partner]);
  assert.equal(JSON.stringify(stored).includes(initial.clientSecret), false);
});

test('Microsoft signing keys without alg verify correctly; callbacks admit allowed tenants and separate tenant identities', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save({ allowedTenantIds: [home, partner] })).statusCode, 200);
  const homeLogin = await f.finish(await f.start(), home);
  assert.equal(homeLogin.headers.location, `${origin}/requests`, homeLogin.body);
  const homeSession = await f.session(homeLogin);
  assert.equal(homeSession.user.role, 'user');
  const partnerLogin = await f.finish(await f.start(), partner);
  const partnerSession = await f.session(partnerLogin);
  assert.ok(partnerSession.user, partnerLogin.body);
  assert.notEqual(partnerSession.user.id, homeSession.user.id);
  assert.equal(partnerSession.user.email, homeSession.user.email);
  const repeat = await f.finish(await f.start(), partner);
  assert.equal((await f.session(repeat)).user.id, partnerSession.user.id);
  const denied = await f.finish(await f.start(), outsider);
  assert.equal(denied.statusCode, 302);
  assert.match(String(denied.headers.location), /auth_error=ENTRA_TENANT_NOT_ALLOWED/);
  assert.equal((await f.session(denied)).user, null);
  assert.equal(
    (await f.app.inject({ url: '/api/users', headers: f.headers })).json().users.length,
    3,
  );
  assert.deepEqual(
    f.db.connection
      .prepare("SELECT accountId FROM account WHERE providerId='microsoft' ORDER BY accountId")
      .all(),
    [{ accountId: `${home}.${objectId}` }, { accountId: `${partner}.${objectId}` }].sort((a, b) =>
      a.accountId.localeCompare(b.accountId),
    ),
  );
  assert.ok(f.network.every((url) => !url.includes('graph.microsoft.com')));
});

test('OAuth callbacks reject forged, expired, wrong-audience, wrong-issuer and wrong-nonce tokens without provisioning users', async (t) => {
  const f = await fixture(t);
  await f.save({ allowedTenantIds: [home, partner] });
  const cases: [Record<string, unknown>, boolean?][] = [
    [{}, true],
    [{ exp: 1 }],
    [{ exp: undefined }],
    [{ aud: 'another-app' }],
    [{ iss: `https://login.microsoftonline.com/${outsider}/v2.0` }],
    [{ nonce: 'wrong' }],
    [{ nonce: undefined }],
    [{ tid: 'organizations' }],
    [{ oid: undefined }],
    [{ nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ];
  for (const [claims, tamper] of cases) {
    const response = await f.finish(await f.start(), partner, claims, tamper);
    assert.equal(response.statusCode, 302, JSON.stringify(claims));
    assert.match(String(response.headers.location), /auth_error=/);
    assert.equal((await f.session(response)).user, null);
  }
  assert.equal(
    (await f.app.inject({ url: '/api/users', headers: f.headers })).json().users.length,
    1,
  );
  assert.equal(
    f.db.connection.prepare("SELECT id FROM account WHERE providerId='microsoft'").all().length,
    0,
  );
});

test('a valid signature with signing key metadata for a different tenant cannot create a session', async (t) => {
  const f = await fixture(t);
  await f.save({ allowedTenantIds: [partner] });
  f.jwk.issuer = `https://login.microsoftonline.com/${outsider}/v2.0`;
  const response = await f.finish(await f.start(), partner);
  assert.match(String(response.headers.location), /auth_error=ENTRA_TOKEN_INVALID/);
  assert.equal((await f.session(response)).user, null);
  assert.equal(
    f.db.connection.prepare("SELECT id FROM account WHERE providerId='microsoft'").all().length,
    0,
  );
});

test('removing a tenant revokes organization sessions and preserves local sessions; the home tenant is not implicitly allowed', async (t) => {
  const f = await fixture(t);
  await f.save({ allowedTenantIds: [home, partner] });
  const response = await f.finish(await f.start(), partner);
  assert.ok((await f.session(response)).user);
  await f.save({ allowedTenantIds: [home] });
  assert.equal((await f.session(response)).user, null);
  assert.ok((await f.app.inject({ url: '/api/session', headers: f.headers })).json().user);
  assert.match(
    String((await f.finish(await f.start(), partner)).headers.location),
    /ENTRA_TENANT_NOT_ALLOWED/,
  );
  assert.ok((await f.session(await f.finish(await f.start(), home))).user);
  await f.save({ allowedTenantIds: [partner] });
  const flow = await f.start();
  assert.equal(flow.url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.match(String((await f.finish(flow, home)).headers.location), /ENTRA_TENANT_NOT_ALLOWED/);
});

test('organization accounts retain their role and disabled state when the allowed tenant list changes', async (t) => {
  const f = await fixture(t);
  await f.save();
  const first = await f.finish(await f.start(), home);
  const user = (await f.session(first)).user;
  assert.ok(user, first.body);
  f.db.connection.prepare("UPDATE user SET role='admin' WHERE id=?").run(user.id);
  await f.save({ allowedTenantIds: [home, partner] });
  const again = (await f.session(await f.finish(await f.start(), home))).user;
  assert.equal(again.id, user.id);
  assert.equal(again.role, 'admin');
  const other = (await f.session(await f.finish(await f.start(), partner))).user;
  assert.notEqual(other.id, user.id);
  assert.equal(other.role, 'user');
  f.db.connection.prepare('UPDATE user SET banned=1 WHERE id=?').run(user.id);
  assert.equal((await f.session(await f.finish(await f.start(), home))).user, null);
  assert.equal(
    (await f.app.inject({ url: '/api/users', headers: f.headers })).json().users.length,
    3,
  );
});

test('the saved default admin setting applies only to first-time organization users, never existing or local accounts', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.save({ allowedTenantIds: [home, partner] })).json().entra.defaultAdmin,
    false,
  );
  const first = await f.finish(await f.start(), home);
  const reader = (await f.session(first)).user;
  assert.equal(reader.role, 'user');

  const saved = await f.save({ allowedTenantIds: [home, partner], defaultAdmin: true });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().entra.defaultAdmin, true);
  const stored = JSON.parse(
    (
      f.db.connection.prepare("SELECT value_json FROM settings WHERE key='entra'").get() as {
        value_json: string;
      }
    ).value_json,
  );
  assert.equal(stored.defaultAdmin, true);
  assert.equal((await f.session(await f.finish(await f.start(), home))).user.role, 'user');
  const newAdmin = (await f.session(await f.finish(await f.start(), partner))).user;
  assert.equal(newAdmin.role, 'admin');

  const local = await f.app.inject({
    method: 'POST',
    url: '/api/users',
    headers: f.headers,
    payload: {
      email: 'local-reader@example.test',
      name: 'Local Reader',
      password: testPassword,
      role: 'user',
    },
  });
  assert.equal(local.statusCode, 201, local.body);
  assert.equal(local.json().user.role, 'user');
  const denied = await f.app.inject({
    method: 'PUT',
    url: '/api/settings/entra',
    headers: { ...requestHeaders, cookie: await login(f.app, 'local-reader@example.test') },
    payload: { ...initial, defaultAdmin: false },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(
    (await f.app.inject({ url: '/api/settings/entra', headers: f.headers })).json().entra
      .defaultAdmin,
    true,
  );

  await f.save({ allowedTenantIds: [home, partner], defaultAdmin: false });
  assert.equal((await f.session(await f.finish(await f.start(), partner))).user.role, 'admin');
  const otherReader = (
    await f.session(
      await f.finish(await f.start(), partner, {
        oid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        role: 'admin',
        roles: ['admin'],
      }),
    )
  ).user;
  assert.equal(otherReader.role, 'user');

  const changed = await f.app.inject({
    method: 'PATCH',
    url: `/api/users/${newAdmin.id}/access`,
    headers: f.headers,
    payload: { role: 'user', enabled: true },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  await f.save({ allowedTenantIds: [home, partner], defaultAdmin: true });
  assert.equal((await f.session(await f.finish(await f.start(), partner))).user.role, 'user');
  const disabled = await f.app.inject({
    method: 'PATCH',
    url: `/api/users/${newAdmin.id}/access`,
    headers: f.headers,
    payload: { role: 'user', enabled: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal((await f.session(await f.finish(await f.start(), partner))).user, null);
});

test('Entra default role settings validate boolean input and survive an application restart', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save({ defaultAdmin: 'true' })).statusCode, 400);
  assert.equal((await f.save({ defaultAdmin: true })).statusCode, 200);
  const restarted = await buildApp(f.config, false, { entraVerifier: async () => {} });
  t.after(async () => {
    await restarted.close();
  });
  const settings = await restarted.inject({ url: '/api/settings/entra', headers: f.headers });
  assert.equal(settings.statusCode, 200, settings.body);
  assert.equal(settings.json().entra.defaultAdmin, true);
});
