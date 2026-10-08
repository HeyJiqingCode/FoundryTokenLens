import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/server/app.js';
import { openDatabase } from '../src/server/database.js';
import { login, requestHeaders, setupAdmin, testApp, testEmail, testPassword } from './helpers.js';

test('email-only users require a unique normalized email and cannot use username login', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const draft = {
    email: '  Reader@Example.Test  ',
    name: 'Reader',
    password: testPassword,
    role: 'user',
  };
  const created = await app.inject({ method: 'POST', url: '/api/users', headers, payload: draft });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().user.email, 'reader@example.test');
  assert.equal('username' in created.json().user, false);
  const viewer = await login(app, '  READER@EXAMPLE.TEST  ');
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: viewer } })).json().user.id,
    created.json().user.id,
  );
  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { ...draft, email: 'READER@example.test' },
  });
  assert.equal(duplicate.statusCode, 409);
  for (const email of [undefined, '', 'reader', 'reader@local.invalid']) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { ...draft, email },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  const concurrent = await Promise.all(
    ['new@example.test', 'NEW@example.test'].map((email) =>
      app.inject({ method: 'POST', url: '/api/users', headers, payload: { ...draft, email } }),
    ),
  );
  assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: requestHeaders,
        payload: { username: 'admin', password: testPassword },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: requestHeaders,
        payload: { email: 'admin', password: testPassword },
      })
    ).statusCode,
    400,
  );
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${created.json().user.id}/access`,
    headers,
    payload: { role: 'user', enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: viewer } })).json().user,
    null,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: requestHeaders,
        payload: { email: 'reader@example.test', password: testPassword },
      })
    ).statusCode,
    403,
  );
});

test('email changes require the password, reject duplicate addresses and block profile-field bypasses', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const user = (await app.inject({ url: '/api/session', headers })).json().user;
  await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { email: 'taken@example.test', name: 'Taken', password: testPassword, role: 'user' },
  });
  const change = (payload: Record<string, unknown>, customHeaders = headers) =>
    app.inject({ method: 'POST', url: '/api/auth/change-email', headers: customHeaders, payload });
  assert.equal((await change({ newEmail: 'next@example.test' })).statusCode, 400);
  assert.equal(
    (await change({ newEmail: 'next@example.test', currentPassword: 'incorrect' })).statusCode,
    400,
  );
  assert.equal(
    (await change({ newEmail: 'TAKEN@example.test', currentPassword: testPassword })).statusCode,
    409,
  );
  assert.equal(
    (
      await change(
        { newEmail: 'next@example.test', currentPassword: testPassword },
        { ...headers, origin: 'https://untrusted.example' },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: requestHeaders,
        payload: { newEmail: 'next@example.test', currentPassword: testPassword },
      })
    ).statusCode,
    401,
  );
  for (const field of ['email', 'organizationEmail', 'username', 'role']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/update-user',
      headers,
      payload: { name: 'Forbidden', [field]: 'next@example.test' },
    });
    assert.equal(response.statusCode, 400);
  }
  const after = (await app.inject({ url: '/api/session', headers })).json().user;
  assert.equal(after.id, user.id);
  assert.equal(after.email, user.email);
  assert.equal(after.name, user.name);
});

test('changing email preserves identity and password, revokes other sessions, and survives restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-email-restart-'));
  const config = {
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: join(directory, 'web'),
  };
  let app = await buildApp(config);
  await setupAdmin(app);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const cookie = await login(app);
  const otherCookie = await login(app);
  const headers = { ...requestHeaders, cookie };
  const before = (await app.inject({ url: '/api/session', headers })).json().user;
  const changed = await app.inject({
    method: 'POST',
    url: '/api/auth/change-email',
    headers,
    payload: { newEmail: ' Changed@Example.Test ', currentPassword: testPassword },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  const after = (await app.inject({ url: '/api/session', headers })).json().user;
  assert.equal(after.email, 'changed@example.test');
  assert.equal(after.id, before.id);
  assert.equal(after.role, before.role);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: otherCookie } })).json().user,
    null,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: requestHeaders,
        payload: { email: testEmail, password: testPassword },
      })
    ).statusCode,
    401,
  );
  await login(app, 'changed@example.test');
  await app.close();
  app = await buildApp(config);
  const persistedCookie = await login(app, 'CHANGED@EXAMPLE.TEST');
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: persistedCookie } })).json().user
      .id,
    before.id,
  );
  const db = openDatabase(directory);
  try {
    assert.equal(
      db.logs.query({ category: 'operation', search: 'user.email', limit: 100, offset: 0 }).total,
      1,
    );
    assert.equal(db.connection.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});

test('email login and email-change password checks are rate limited', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  for (let i = 0; i < 5; i++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/change-email',
      headers,
      payload: { newEmail: `new${i}@example.test`, currentPassword: 'incorrect' },
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers,
        payload: { newEmail: 'next@example.test', currentPassword: testPassword },
      })
    ).statusCode,
    429,
  );
  // testApp already performed one email sign-in from this IP.
  for (let i = 0; i < 9; i++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: requestHeaders,
      payload: { email: `missing${i}@example.test`, password: 'incorrect' },
    });
    assert.equal(response.statusCode, 401);
  }
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: requestHeaders,
        payload: { email: testEmail, password: testPassword },
      })
    ).statusCode,
    429,
  );
});

test('organization emails are displayed without exposing internal identifiers or enabling local changes', async (t) => {
  const { app, directory, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: {
      email: 'external@example.test',
      name: 'Organization user',
      password: testPassword,
      role: 'user',
    },
  });
  const externalCookie = await login(app, 'external@example.test');
  const db = openDatabase(directory);
  try {
    db.connection
      .prepare("UPDATE account SET providerId='microsoft', password=NULL WHERE userId=?")
      .run(created.json().user.id);
    db.connection
      .prepare(
        "UPDATE user SET email='tenant.object@entra.invalid', organizationEmail='external@example.test' WHERE id=?",
      )
      .run(created.json().user.id);
  } finally {
    db.close();
  }
  const session = await app.inject({ url: '/api/session', headers: { cookie: externalCookie } });
  assert.equal(session.json().user.email, 'external@example.test');
  assert.equal(session.json().user.hasLocalPassword, false);
  assert.equal(session.body.includes('entra.invalid'), false);
  const list = await app.inject({ url: '/api/users', headers });
  assert.equal(list.body.includes('entra.invalid'), false);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/change-email',
        headers: { ...requestHeaders, cookie: externalCookie },
        payload: { newEmail: 'new@example.test', currentPassword: testPassword },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: requestHeaders,
        payload: { email: 'external@example.test', password: testPassword },
      })
    ).statusCode,
    401,
  );
});
