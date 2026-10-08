import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../src/server/database.js';
import { login, requestHeaders, testApp, testPassword } from './helpers.js';

async function createUser(app: FastifyInstance, cookie: string, email: string, role = 'user') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { ...requestHeaders, cookie },
    payload: { email, name: email.split('@')[0], password: testPassword, role },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().user;
}

test('the initial local administrator is permanently identified and cannot be demoted by another admin', async (t) => {
  const { app, cookie } = await testApp(t);
  const initial = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  assert.equal(initial.isInitialAdmin, true);
  const other = await createUser(app, cookie, 'other-admin@example.test', 'admin');
  assert.equal(other.isInitialAdmin, false);
  const otherHeaders = { ...requestHeaders, cookie: await login(app, other.email) };
  const rejected = await app.inject({
    method: 'PATCH',
    url: `/api/users/${initial.id}/access`,
    headers: otherHeaders,
    payload: { role: 'user', enabled: true },
  });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, 'auth.initialLocalAdministratorSRoleCannotBeChanged');
  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/users/${initial.id}`,
    headers: otherHeaders,
    payload: { name: 'Renamed Initial Admin', email: 'renamed@example.test' },
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().user.isInitialAdmin, true);
  assert.equal(renamed.json().user.role, 'admin');
});

test('disabled admins do not count and concurrent disable operations cannot remove all active admins', async (t) => {
  const { app, cookie } = await testApp(t);
  const initial = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  const other = await createUser(app, cookie, 'second@example.test', 'admin');
  const access = (id: string, enabled: boolean, actorCookie = cookie, role = 'admin') =>
    app.inject({
      method: 'PATCH',
      url: `/api/users/${id}/access`,
      headers: { ...requestHeaders, cookie: actorCookie },
      payload: { role, enabled },
    });
  assert.equal((await access(other.id, false)).statusCode, 200);
  assert.equal((await access(initial.id, false)).statusCode, 409);
  assert.equal((await access(other.id, true)).statusCode, 200);
  const secondCookie = await login(app, other.email);
  assert.equal((await access(initial.id, false, secondCookie)).statusCode, 200);
  assert.equal((await access(other.id, false, secondCookie)).statusCode, 409);
  assert.equal((await access(other.id, true, secondCookie, 'user')).statusCode, 409);
  assert.equal((await access(initial.id, true, secondCookie)).statusCode, 200);
  const result = await Promise.all([
    access(initial.id, false, secondCookie),
    access(other.id, false, secondCookie),
  ]);
  assert.equal(result.filter((r) => r.statusCode === 200).length, 1);
  assert.ok(result.every((r) => [200, 401, 403, 409].includes(r.statusCode)));
  const survivorEmail = result[0].statusCode === 200 ? other.email : initial.email;
  const survivor = await login(app, survivorEmail);
  const users = (await app.inject({ url: '/api/users', headers: { cookie: survivor } })).json()
    .users;
  assert.equal(
    users.filter((u: { role: string; enabled: boolean }) => u.role === 'admin' && u.enabled).length,
    1,
  );
});

test('administrators cannot disable or demote themselves even with other active administrators; rejected changes preserve sessions', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const initial = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  const local = await createUser(app, cookie, 'self-local@example.test', 'admin');
  const external = await createUser(app, cookie, 'self-entra@example.test', 'admin');
  const localCookie = await login(app, local.email);
  const externalCookie = await login(app, external.email);
  const db = openDatabase(directory);
  try {
    db.connection
      .prepare("UPDATE account SET providerId = 'microsoft', password = NULL WHERE userId = ?")
      .run(external.id);
    for (const [target, sessionCookie] of [
      [initial, cookie],
      [local, localCookie],
      [external, externalCookie],
    ] as const) {
      const beforeAudit = (
        db.connection
          .prepare("SELECT count(*) AS n FROM system_logs WHERE action = 'user.access'")
          .get() as { n: number }
      ).n;
      const headers = { ...requestHeaders, cookie: sessionCookie };
      const disabled = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}/access`,
        headers,
        payload: { role: 'admin', enabled: false },
      });
      assert.equal(disabled.statusCode, 409, disabled.body);
      assert.equal(disabled.json().code, 'auth.youCannotDisableYourOwnAccount');
      const demoted = await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}/access`,
        headers,
        payload: { role: 'user', enabled: true },
      });
      assert.equal(demoted.statusCode, 409, demoted.body);
      if (!target.isInitialAdmin)
        assert.equal(demoted.json().code, 'auth.youCannotChangeYourOwnRole');
      const unchanged = (await app.inject({ url: '/api/session', headers })).json().user;
      assert.equal(unchanged.id, target.id);
      assert.equal(unchanged.role, 'admin');
      assert.equal(unchanged.enabled, true);
      assert.equal(
        (
          db.connection
            .prepare("SELECT count(*) AS n FROM system_logs WHERE action = 'user.access'")
            .get() as { n: number }
        ).n,
        beforeAudit,
      );
    }
    const allowed = await app.inject({
      method: 'PATCH',
      url: `/api/users/${local.id}/access`,
      headers: { ...requestHeaders, cookie },
      payload: { role: 'admin', enabled: false },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(
      (await app.inject({ url: '/api/session', headers: { cookie: localCookie } })).json().user,
      null,
    );
    assert.equal(
      (await app.inject({ url: '/api/session', headers: { cookie } })).json().user.id,
      initial.id,
    );
  } finally {
    db.close();
  }
});

test('admin profile editing validates permissions and email uniqueness, preserves roles, and revokes the edited user sessions', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const target = await createUser(app, cookie, 'reader@example.test');
  await createUser(app, cookie, 'taken@example.test');
  const targetCookie = await login(app, target.email);
  const edit = (payload: Record<string, unknown>, customHeaders = headers) =>
    app.inject({
      method: 'PATCH',
      url: `/api/users/${target.id}`,
      headers: customHeaders,
      payload,
    });
  assert.equal(
    (await edit({ name: 'Changed' }, { ...requestHeaders, cookie: targetCookie })).statusCode,
    403,
  );
  assert.equal(
    (await edit({ name: 'Changed' }, { ...headers, origin: 'https://other.example' })).statusCode,
    403,
  );
  for (const extra of [
    { role: 'admin' },
    { enabled: false },
    { isInitialAdmin: true },
    { password: testPassword },
  ]) {
    assert.equal((await edit({ name: 'Invalid', ...extra })).statusCode, 400);
  }
  assert.equal((await edit({ name: 'Invalid', email: 'TAKEN@example.test' })).statusCode, 409);
  let users = (await app.inject({ url: '/api/users', headers })).json().users;
  assert.equal(users.find((u: { id: string }) => u.id === target.id).name, target.name);
  const changed = await edit({ name: 'Edited Reader', email: ' NEXT@Example.Test ' });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().user.email, 'next@example.test');
  assert.equal(changed.json().user.role, 'user');
  assert.equal(changed.json().user.isInitialAdmin, false);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: targetCookie } })).json().user,
    null,
  );
  await login(app, 'next@example.test');
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${target.id}/access`,
    headers,
    payload: { role: 'user', enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal((await edit({ name: 'Edited While Disabled' })).statusCode, 200);
  users = (await app.inject({ url: '/api/users', headers })).json().users;
  assert.equal(users.find((u: { id: string }) => u.id === target.id).enabled, false);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: '/api/users/missing',
        headers,
        payload: { name: 'Unknown' },
      })
    ).statusCode,
    404,
  );
});

test('admin password resets reject unauthorized access, revoke old sessions, hash the new password and preserve the editing admin session', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const admin = (await app.inject({ url: '/api/session', headers })).json().user;
  const target = await createUser(app, cookie, 'reset@example.test');
  const targetCookie = await login(app, target.email);
  const reset = (id: string, newPassword: string, customHeaders = headers) =>
    app.inject({
      method: 'POST',
      url: `/api/users/${id}/password`,
      headers: customHeaders,
      payload: { newPassword },
    });
  const password = 'Replacement-test-password-73!';
  assert.equal(
    (await reset(admin.id, password, { ...requestHeaders, cookie: targetCookie })).statusCode,
    403,
  );
  assert.equal((await reset(target.id, 'short')).statusCode, 400);
  assert.equal((await reset(target.id, 'x'.repeat(129))).statusCode, 400);
  const changed = await reset(target.id, password);
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: targetCookie } })).json().user,
    null,
  );
  const old = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: requestHeaders,
    payload: { email: target.email, password: testPassword },
  });
  assert.notEqual(old.statusCode, 200);
  await login(app, target.email, password);
  const otherAdminSession = await login(app);
  assert.equal((await reset(admin.id, password)).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/session', headers })).json().user.id, admin.id);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: otherAdminSession } })).json().user,
    null,
  );
  const db = openDatabase(directory);
  try {
    const credential = db.connection
      .prepare("SELECT password FROM account WHERE userId = ? AND providerId = 'credential'")
      .get(target.id) as { password: string };
    assert.notEqual(credential.password, password);
    assert.equal(
      JSON.stringify(db.logs.query({ category: 'operation', limit: 100, offset: 0 })).includes(
        password,
      ),
      false,
    );
    assert.equal(
      db.logs.query({ category: 'operation', search: 'user.password_reset', limit: 100, offset: 0 })
        .total,
      2,
    );
  } finally {
    db.close();
  }
});

test('Entra accounts can be edited without creating local credentials or replacing their organization email', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const target = await createUser(app, cookie, 'organization@example.test');
  const db = openDatabase(directory);
  db.connection
    .prepare("UPDATE account SET providerId = 'microsoft', password = NULL WHERE userId = ?")
    .run(target.id);
  db.close();
  const edited = await app.inject({
    method: 'PATCH',
    url: `/api/users/${target.id}`,
    headers,
    payload: { name: 'Organization User' },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().user.hasLocalPassword, false);
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/users/${target.id}`,
        headers,
        payload: { name: 'Forbidden', email: 'different@example.test' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/users/${target.id}/password`,
        headers,
        payload: { newPassword: testPassword },
      })
    ).statusCode,
    403,
  );
});

test('users can be created disabled and cannot sign in until enabled', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const email = 'disabled-new@example.test';
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { email, name: 'Disabled', password: testPassword, role: 'user', enabled: false },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().user.enabled, false);
  const signIn = () =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: requestHeaders,
      payload: { email, password: testPassword },
    });
  assert.notEqual((await signIn()).statusCode, 200);
  const enabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${created.json().user.id}/access`,
    headers,
    payload: { role: 'user', enabled: true },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal((await signIn()).statusCode, 200);
});

test('access patches preserve fields changed by another administrator and reject empty changes', async (t) => {
  const { app, cookie } = await testApp(t);
  const headers = { ...requestHeaders, cookie };
  const created = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers,
    payload: { email: 'patch@example.test', name: 'Patch', password: testPassword, role: 'user' },
  });
  const id = created.json().user.id;
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/users/${id}/access`,
        headers,
        payload: { role: 'admin' },
      })
    ).statusCode,
    200,
  );
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${id}/access`,
    headers,
    payload: { enabled: false },
  });
  assert.equal(disabled.json().user.role, 'admin');
  assert.equal(disabled.json().user.enabled, false);
  const role = await app.inject({
    method: 'PATCH',
    url: `/api/users/${id}/access`,
    headers,
    payload: { role: 'user' },
  });
  assert.equal(role.json().user.enabled, false);
  assert.equal(
    (await app.inject({ method: 'PATCH', url: `/api/users/${id}/access`, headers, payload: {} }))
      .statusCode,
    400,
  );
});
