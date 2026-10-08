import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import type { SourceInspector } from '../src/server/sources/azure-blob.js';

export const origin = 'http://127.0.0.1:8080';
export const testPassword = 'Test-only-password-928!';
export const testEmail = 'admin@example.test';
export const requestHeaders = { origin, 'x-ftl-request': '1' };
export async function login(app: FastifyInstance, email = testEmail, password = testPassword) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: requestHeaders,
    payload: { email, password },
  });
  if (response.statusCode !== 200)
    throw new Error(`Login failed: ${response.statusCode} ${response.body}`);
  const cookies = response.headers['set-cookie'];
  return (Array.isArray(cookies) ? cookies : [cookies ?? ''])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}
/** Creates the first administrator through the setup form, as the first visit to the platform does. */
export async function setupAdmin(app: FastifyInstance, from = origin) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    headers: { origin: from, 'x-ftl-request': '1' },
    payload: { email: testEmail, name: 'Administrator', password: testPassword },
  });
  if (response.statusCode !== 201)
    throw new Error(`Setup failed: ${response.statusCode} ${response.body}`);
  return response.json().user;
}
export async function testApp(t: TestContext, inspector?: SourceInspector) {
  const directory = mkdtempSync(join(tmpdir(), 'ftl-settings-test-'));
  const config: AppConfig = {
    host: '127.0.0.1',
    port: 8080,
    dataDir: directory,
    webDir: join(directory, 'web'),
  };
  const app = await buildApp(config, false, { sourceInspector: inspector });
  await setupAdmin(app);
  t.after(async () => {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, directory, config, cookie: await login(app) };
}
