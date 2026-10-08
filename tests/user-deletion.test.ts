import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../src/server/database.js';
import { taskDefaults } from '../src/shared/scheduled-tasks.js';
import { login, requestHeaders, testApp, testPassword } from './helpers.js';

async function create(app: FastifyInstance, cookie: string, email: string, role = 'user') {
  const result = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { ...requestHeaders, cookie },
    payload: { email, name: email.split('@')[0], password: testPassword, role },
  });
  assert.equal(result.statusCode, 201, result.body);
  return result.json().user;
}
function remove(app: FastifyInstance, cookie: string, id: string, confirmation: string) {
  return app.inject({
    method: 'DELETE',
    url: `/api/users/${id}`,
    headers: { ...requestHeaders, cookie },
    payload: { confirmation },
  });
}

test('deleting a user removes credentials and sessions while retaining prices, settings and the audit trail', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const target = await create(app, cookie, 'delete-me@example.test');
  const targetCookie = await login(app, target.email);
  const headers = { ...requestHeaders, cookie };
  const price = await app.inject({
    method: 'POST',
    url: '/api/settings/prices',
    headers,
    payload: {
      model: 'deletion-fixture',
      modelVersion: '*',
      region: '*',
      deploymentType: '*',
      validFrom: '2026-09-01T00:00:00Z',
      validTo: null,
      notes: 'Keep this business record',
      items: [{ key: 'input', label: 'Input', unitQuantity: 1000000, unitPriceUsd: '1' }],
    },
  });
  assert.equal(price.statusCode, 201, price.body);
  const beforePrices = (await app.inject({ url: '/api/settings/prices', headers })).json();
  const task = await app.inject({
    method: 'POST',
    url: '/api/settings/tasks',
    headers,
    payload: { ...taskDefaults('daily'), name: 'Kept', enabled: false },
  });
  assert.equal(task.statusCode, 201, task.body);
  const beforeTasks = (await app.inject({ url: '/api/settings/tasks', headers })).json();
  const result = await remove(app, cookie, target.id, ' DELETE-ME@EXAMPLE.TEST ');
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().deleted, true);
  assert.equal(
    (await app.inject({ url: '/api/session', headers: { cookie: targetCookie } })).json().user,
    null,
  );
  assert.deepEqual(
    (await app.inject({ url: '/api/settings/prices', headers })).json(),
    beforePrices,
  );
  assert.deepEqual((await app.inject({ url: '/api/settings/tasks', headers })).json(), beforeTasks);
  const db = openDatabase(directory);
  try {
    for (const table of ['user', 'session', 'account']) {
      const key = table === 'user' ? 'id' : 'userId';
      assert.equal(
        (
          db.connection
            .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key} = ?`)
            .get(target.id) as { n: number }
        ).n,
        0,
      );
    }
    const logs = db.logs.query({ category: 'operation', limit: 100, offset: 0 }).logs;
    const audit = logs.find(
      (log) => log.action === 'user.delete' && log.details.includes(target.email),
    );
    assert.ok(audit);
    assert.ok(audit.actor);
    assert.ok(!JSON.stringify(audit).includes(testPassword));
    assert.ok(logs.some((log) => log.action !== 'user.delete'));
  } finally {
    db.close();
  }
  const oldLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: requestHeaders,
    payload: { email: target.email, password: testPassword },
  });
  assert.notEqual(oldLogin.statusCode, 200);
  const replacement = await create(app, cookie, target.email);
  assert.notEqual(replacement.id, target.id);
});

test('deletion requires admin rights, a trusted origin and explicit matching confirmation', async (t) => {
  const { app, cookie } = await testApp(t);
  const target = await create(app, cookie, 'target@example.test');
  const viewer = await create(app, cookie, 'viewer@example.test');
  const viewerCookie = await login(app, viewer.email);
  assert.equal((await remove(app, viewerCookie, target.id, target.email)).statusCode, 403);
  assert.equal((await remove(app, '', target.id, target.email)).statusCode, 401);
  assert.equal((await remove(app, cookie, target.id, 'wrong@example.test')).statusCode, 400);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/users/${target.id}`,
        headers: { cookie, ...requestHeaders, origin: 'https://untrusted.example' },
        payload: { confirmation: target.email },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/users/${target.id}`,
        headers: { ...requestHeaders, cookie },
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/users/${target.id}`,
        headers: { ...requestHeaders, cookie },
        payload: { confirmation: target.email, bypass: true },
      })
    ).statusCode,
    400,
  );
  assert.equal((await remove(app, cookie, 'missing', target.email)).statusCode, 404);
  const users = (await app.inject({ url: '/api/users', headers: { cookie } })).json().users;
  assert.ok(users.some((user: { id: string }) => user.id === target.id));
});

test('initial and current administrators cannot be deleted, and cross-admin deletion races leave an active administrator', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const initial = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  const a = await create(app, cookie, 'admin-a@example.test', 'admin');
  const b = await create(app, cookie, 'admin-b@example.test', 'admin');
  const aCookie = await login(app, a.email);
  const bCookie = await login(app, b.email);
  assert.equal((await remove(app, aCookie, initial.id, initial.email)).statusCode, 409);
  assert.equal((await remove(app, aCookie, a.id, a.email)).statusCode, 409);
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${initial.id}/access`,
    headers: { ...requestHeaders, cookie: aCookie },
    payload: { role: 'admin', enabled: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  const outcomes = await Promise.all([
    remove(app, aCookie, b.id, b.email),
    remove(app, bCookie, a.id, a.email),
  ]);
  assert.equal(outcomes.filter((result) => result.statusCode === 200).length, 1);
  const db = openDatabase(directory);
  try {
    assert.equal(
      (
        db.connection
          .prepare(
            "SELECT count(*) AS n FROM user WHERE role = 'admin' AND (banned IS NULL OR banned = 0)",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    assert.ok(db.connection.prepare('SELECT id FROM user WHERE id = ?').get(initial.id));
  } finally {
    db.close();
  }
});

test('the final active local administrator is protected even when an Entra administrator remains', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const initial = (await app.inject({ url: '/api/session', headers: { cookie } })).json().user;
  const local = await create(app, cookie, 'local@example.test', 'admin');
  const external = await create(app, cookie, 'external@example.test', 'admin');
  const externalCookie = await login(app, external.email);
  const db = openDatabase(directory);
  db.connection
    .prepare("UPDATE account SET providerId = 'microsoft', password = NULL WHERE userId = ?")
    .run(external.id);
  db.close();
  const disabled = await app.inject({
    method: 'PATCH',
    url: `/api/users/${initial.id}/access`,
    headers: { ...requestHeaders, cookie: externalCookie },
    payload: { role: 'admin', enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  const result = await remove(app, externalCookie, local.id, local.email);
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().code, 'auth.recoveryAdminRequired');
});

test('Entra accounts without a public email require their display name and deletion rolls back completely on failure', async (t) => {
  const { app, cookie, directory } = await testApp(t);
  const external = await create(app, cookie, 'organization@example.test');
  const targetCookie = await login(app, external.email);
  const db = openDatabase(directory);
  try {
    db.connection
      .prepare("UPDATE account SET providerId = 'microsoft', password = NULL WHERE userId = ?")
      .run(external.id);
    db.connection
      .prepare(
        "UPDATE user SET email = 'subject@entra.invalid', organizationEmail = NULL, name = '组织用户' WHERE id = ?",
      )
      .run(external.id);
    assert.equal((await remove(app, cookie, external.id, 'subject@entra.invalid')).statusCode, 400);
    db.connection.exec(
      "CREATE TRIGGER qa_block_delete BEFORE DELETE ON user BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END",
    );
    assert.equal((await remove(app, cookie, external.id, '组织用户')).statusCode, 409);
    assert.ok(db.connection.prepare('SELECT id FROM user WHERE id = ?').get(external.id));
    assert.ok(db.connection.prepare('SELECT id FROM account WHERE userId = ?').get(external.id));
    assert.ok(db.connection.prepare('SELECT id FROM session WHERE userId = ?').get(external.id));
    assert.equal(
      (
        db.connection
          .prepare("SELECT count(*) AS n FROM system_logs WHERE action = 'user.delete'")
          .get() as { n: number }
      ).n,
      0,
    );
    db.connection.exec('DROP TRIGGER qa_block_delete');
    assert.equal((await remove(app, cookie, external.id, '组织用户')).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/api/session', headers: { cookie: targetCookie } })).json().user,
      null,
    );
  } finally {
    db.close();
  }
});
