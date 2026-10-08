import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { z } from 'zod';
import { HttpError, registerErrors } from '../src/server/http/errors.js';
import { apiErrorMessage } from '../src/shared/api-error.js';
import { formatSystemMessage, message } from '../src/shared/i18n/translate.js';

test('default validation failures render in both languages without exposing submitted credentials', async (t) => {
  const app = Fastify();
  registerErrors(app);
  app.post('/validate', async (request) => {
    z.object({
      clientId: z.string().uuid(),
      password: z.string().min(8),
      quantity: z.number().positive(),
    })
      .strict()
      .parse(request.body);
    return { ok: true };
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/validate',
    payload: {
      clientId: 'private-client-value',
      password: 'secret',
      quantity: 0,
    },
  });
  assert.equal(response.statusCode, 400);
  const text = apiErrorMessage(response.json());
  assert.equal(
    formatSystemMessage(text, 'zh-CN'),
    'Client ID：请输入有效的 ID（UUID）。；密码：至少输入 8 个字符。；quantity：数值必须大于 0。',
  );
  assert.equal(response.body.includes('private-client-value'), false);
  assert.equal(response.body.includes('secret'), false);
  assert.equal(
    formatSystemMessage(text, 'en-US'),
    'Client ID: Enter a valid ID (UUID).; Password: Enter at least 8 characters.; quantity: The value must be greater than 0.',
  );
  const unknown = await app.inject({
    method: 'POST',
    url: '/validate',
    payload: {
      clientId: '11111111-1111-4111-8111-111111111111',
      password: 'Test-password-123',
      quantity: 1,
      unexpected: 'not-for-display',
    },
  });
  assert.equal(unknown.json().issues[0].code, 'errors.unsupportedFields');
  assert.equal(
    formatSystemMessage(apiErrorMessage(unknown.json()), 'en-US'),
    'The request contains unsupported fields.',
  );
});

test('stable HTTP message keys retain readable API errors and named interpolation', () => {
  const error = new HttpError(
    409,
    message('auth.useCanonicalOrigin', { url: 'https://lens.example.test' }),
  );
  assert.equal(error.statusCode, 409);
  assert.equal(error.message, 'auth.useCanonicalOrigin');
  assert.equal(
    formatSystemMessage(apiErrorMessage(error.body), 'en-US'),
    'Open https://lens.example.test before signing in with Microsoft so the session and callback use the same address.',
  );
});
