import { message } from '../../shared/i18n/translate.js';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';
import { loginPath, safeReturnPath } from '../../shared/navigation.js';
import { ENTRA_LOGIN_ERRORS } from '../../shared/entra-errors.js';
import {
  changeEmailSchema,
  createUserSchema,
  emailSchema,
  passwordSchema,
} from '../settings/validation.js';
import {
  entraSchema,
  verifyEntraTenant,
  type EntraRepository,
  type EntraVerifier,
} from './entra.js';
import type { AuthService } from './service.js';

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
  entra: EntraRepository,
  verifier: EntraVerifier = verifyEntraTenant,
) {
  app.addHook('onRequest', async (request) => {
    if (
      !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ||
      !request.url.startsWith('/api/')
    )
      return;
    const origin = String(request.headers.origin ?? '');
    // Before the first administrator exists, setup comes from whichever address the platform was
    // opened at; setup then records that address as the platform URL.
    const firstSetup = request.url === '/api/setup' && origin !== '' && service.acceptsFirstSetup();
    if (
      (!firstSetup && !service.trustedOrigins.includes(origin)) ||
      request.headers['x-ftl-request'] !== '1'
    ) {
      throw new HttpError(403, 'auth.requestOriginIsNotAllowed');
    }
  });
  app.get('/api/session', async (request) => ({
    setupRequired: service.countUsers() === 0,
    user: await service.currentUser(request),
    entraEnabled: entra.get().enabled,
    publicUrl: service.origin,
  }));
  app.get('/api/settings/entra', async (request) => {
    await service.requireAdmin(request);
    return { entra: entra.get() };
  });
  app.patch('/api/settings/entra', async (request) => {
    const user = await service.requireAdmin(request);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const saved = entra.get();
    if (enabled) await Promise.all(saved.allowedTenantIds.map((id) => verifier(id)));
    const result = entra.setEnabled(enabled, user.id);
    service.reloadProviders();
    return { entra: result };
  });
  app.put('/api/settings/entra', async (request) => {
    const user = await service.requireAdmin(request);
    const input = entraSchema.parse(request.body);
    if (input.enabled)
      await Promise.all(input.allowedTenantIds.map((tenantId) => verifier(tenantId)));
    const saved = entra.save(input, user.id);
    service.reloadProviders();
    return { entra: saved };
  });
  app.post('/api/setup', async (request, reply) => {
    const input = createUserSchema.parse(request.body);
    const user = await service.initialize(input, String(request.headers.origin ?? ''));
    return reply.code(201).send({ user });
  });

  const allowed = new Set([
    '/api/auth/sign-in/email',
    '/api/auth/change-email',
    '/api/auth/sign-out',
    '/api/auth/change-password',
    '/api/auth/update-user',
    '/api/auth/sign-in/social',
    '/api/auth/callback/microsoft',
  ]);
  app.get('/api/auth/error', async (_request, reply) =>
    reply.redirect(loginPath('/overview', true)),
  );
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const path = request.url.split('?')[0];
      const callback = path === '/api/auth/callback/microsoft';
      if (!allowed.has(path) || request.method !== (callback ? 'GET' : 'POST'))
        return reply.code(404).send({ error: 'Not found' });
      let body: unknown = request.body;
      if (callback || path.endsWith('/sign-in/social')) {
        if (!entra.get().enabled) throw new HttpError(409, 'auth.entraSignInIsNotEnabled');
        if (!callback) {
          const input = z
            .object({ provider: z.literal('microsoft'), returnTo: z.string().max(8192).optional() })
            .strict()
            .parse(request.body);
          if (request.headers.origin !== service.origin)
            throw new HttpError(409, message('auth.useCanonicalOrigin', { url: service.origin }));
          body = {
            provider: 'microsoft',
            callbackURL: `${service.origin}${safeReturnPath(input.returnTo)}`,
            errorCallbackURL: `${service.origin}${loginPath(safeReturnPath(input.returnTo), true)}`,
          };
        }
      } else if (path.endsWith('/sign-in/email')) {
        body = z
          .object({ email: emailSchema, password: z.string().min(1).max(128) })
          .strict()
          .parse(request.body);
      } else if (path.endsWith('/update-user')) {
        await service.requireUser(request);
        body = z
          .object({ name: z.string().trim().min(1).max(100) })
          .strict()
          .parse(request.body);
      } else if (path.endsWith('/change-email')) {
        const user = await service.requireUser(request);
        if (!user.hasLocalPassword)
          throw new HttpError(403, 'auth.organizationEmailIsManagedByMicrosoftEntraID');
        body = changeEmailSchema.parse(request.body);
      } else if (path.endsWith('/change-password')) {
        await service.requireUser(request);
        body = z
          .object({
            currentPassword: z.string().min(1).max(128),
            newPassword: passwordSchema,
            revokeOtherSessions: z.literal(true),
          })
          .strict()
          .parse(request.body);
      }
      const headers = fromNodeHeaders(request.headers);
      headers.delete('content-length');
      headers.set('x-ftl-client-ip', request.ip);
      const response = await service.auth.handler(
        new Request(new URL(request.url, service.origin), {
          method: request.method,
          headers,
          body: request.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        }),
      );
      if (callback && response.status >= 400) {
        const error = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: string } | null;
        const url = new URL(loginPath('/overview', true), service.origin);
        if (error?.code && Object.hasOwn(ENTRA_LOGIN_ERRORS, error.code))
          url.searchParams.set('auth_error', error.code);
        return reply.redirect(`${url.pathname}${url.search}`);
      }
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      return reply.code(response.status).send(await response.text());
    },
  });

  app.get('/api/users', async (request) => {
    await service.requireAdmin(request);
    return { users: service.listUsers() };
  });
  app.post('/api/users', async (request, reply) => {
    const actor = await service.requireAdmin(request);
    const user = await service.createUser(request.body, actor.id);
    return reply.code(201).send({ user });
  });
  app.patch('/api/users/:id', async (request) => {
    const actor = await service.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    return { user: await service.editUser(id, request.body, actor, request) };
  });
  app.delete('/api/users/:id', async (request) => {
    const actor = await service.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    service.deleteUser(id, request.body, actor);
    return { deleted: true };
  });
  app.post('/api/users/:id/password', async (request) => {
    const actor = await service.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    await service.resetUserPassword(id, request.body, actor, request);
    return { status: true };
  });
  app.patch('/api/users/:id/access', async (request) => {
    const actor = await service.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const input = z
      .object({ role: z.enum(['admin', 'user']).optional(), enabled: z.boolean().optional() })
      .refine(
        (input) => input.role !== undefined || input.enabled !== undefined,
        'errors.unsupportedFields',
      )
      .strict()
      .parse(request.body);
    return { user: service.updateAccess(id, input, actor) };
  });
}
