import { recordAudit } from '../platform/audit-format.js';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { admin } from 'better-auth/plugins';
import { hashPassword } from 'better-auth/crypto';
import type { FastifyRequest } from 'fastify';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type SessionUser,
} from '../../shared/settings.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../database.js';
import { HttpError } from '../http/errors.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import {
  changeEmailSchema,
  createUserSchema,
  deleteUserSchema,
  editUserSchema,
  emailSchema,
  resetUserPasswordSchema,
} from '../settings/validation.js';
import type { EntraRepository } from './entra.js';
import { entraTenantAccess } from './entra-provider.js';
import { normalizePublicUrl } from '../../shared/public-url.js';

interface UserRow {
  id: string;
  email: string;
  organizationEmail: string | null;
  name: string;
  role: string | null;
  banned: number | null;
}
const isLoopback = (host: string) =>
  ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
const publicEmail = (value: unknown) => {
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export async function createAuthService(
  database: AppDatabase,
  config: AppConfig,
  secret: string,
  entra: EntraRepository,
) {
  const listensLocally = isLoopback(config.host);
  function getOrigin() {
    return entra.get().publicUrl;
  }
  function getTrustedOrigins() {
    const origin = getOrigin();
    const publicUrl = new URL(origin);
    const trustedOrigins = [origin];
    if (listensLocally && isLoopback(publicUrl.hostname.replace(/^\[|\]$/g, ''))) {
      for (const hostname of ['127.0.0.1', 'localhost']) {
        const alias = new URL(origin);
        alias.hostname = hostname;
        if (!trustedOrigins.includes(alias.origin)) trustedOrigins.push(alias.origin);
      }
    }
    return trustedOrigins;
  }
  function makeAuth() {
    const provider = entra.credentials();
    return betterAuth({
      appName: 'Foundry Token Lens',
      telemetry: { enabled: false },
      baseURL: getOrigin(),
      secret,
      database: database.connection,
      trustedOrigins: getTrustedOrigins(),
      account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
      databaseHooks: {
        user: {
          create: {
            async before(user, context) {
              if (context?.path !== '/callback/:id' || context.params?.id !== 'microsoft') return;
              return { data: { ...user, role: entra.get().defaultAdmin ? 'admin' : 'user' } };
            },
          },
        },
      },
      user: {
        changeEmail: { enabled: true, updateEmailWithoutVerification: true },
        additionalFields: {
          // Provider mapping allows input; public profile routes strictly whitelist fields.
          organizationEmail: { type: 'string', required: false, input: true, returned: false },
        },
      },
      socialProviders: provider
        ? {
            microsoft: {
              ...provider,
              disableProfilePhoto: true,
              disableIdTokenSignIn: true,
              disableDefaultScope: true,
              scope: ['openid', 'profile', 'email'],
              prompt: 'select_account',
              overrideUserInfoOnSignIn: true,
              mapProfileToUser(profile) {
                return {
                  email: `${profile.tid.toLowerCase()}.${profile.oid.toLowerCase()}@entra.invalid`,
                  organizationEmail:
                    publicEmail(profile.email) ?? publicEmail(profile.preferred_username),
                  name: profile.name || 'Entra 用户',
                };
              },
            },
          }
        : {},
      emailAndPassword: {
        enabled: true,
        disableSignUp: true,
        minPasswordLength: PASSWORD_MIN_LENGTH,
        maxPasswordLength: PASSWORD_MAX_LENGTH,
      },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      rateLimit: {
        enabled: true,
        storage: 'database',
        window: 60,
        max: 60,
        customRules: {
          '/sign-in/email': { window: 60, max: 10 },
          '/change-email': { window: 60, max: 5 },
        },
      },
      advanced: {
        cookiePrefix: `ftl-${database.instanceId.slice(0, 8)}`,
        ipAddress: { ipAddressHeaders: ['x-ftl-client-ip'] },
      },
      plugins: [admin(), entraTenantAccess(entra)],
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== '/change-email') return;
          const parsed = changeEmailSchema.safeParse(ctx.body);
          if (!parsed.success)
            throw new APIError('BAD_REQUEST', {
              message: 'auth.enterAValidEmailAndYourCurrentPassword',
            });
          const session = await getSessionFromCtx(ctx);
          if (!session) throw new APIError('UNAUTHORIZED', { message: 'auth.signInFirst' });
          const credential = await ctx.context.internalAdapter.findCredentialAccount(
            session.user.id,
          );
          if (!credential?.password)
            throw new APIError('FORBIDDEN', {
              message: 'auth.organizationEmailIsManagedByMicrosoftEntraID',
            });
          const valid = await ctx.context.password.verify({
            hash: credential.password,
            password: parsed.data.currentPassword,
          });
          if (!valid) throw new APIError('BAD_REQUEST', { message: 'auth.invalidCurrentPassword' });
          if (
            database.connection
              .prepare('SELECT id FROM user WHERE email = ? COLLATE NOCASE AND id <> ?')
              .get(parsed.data.newEmail, session.user.id)
          )
            throw new APIError('CONFLICT', { message: 'auth.emailIsAlreadyInUse' });
        }),
        after: createAuthMiddleware(async (ctx) => {
          const session = ctx.context.session;
          if (!session) return;
          const result = ctx.context.returned as
            { status?: boolean; user?: { id?: string } } | undefined;
          const id = session.user.id;
          let action: string;
          let before: Record<string, unknown>;
          let after: Record<string, unknown>;
          if (ctx.path === '/update-user' && result?.status === true) {
            if (ctx.body.name === session.user.name) return;
            action = 'user.profile';
            before = { name: session.user.name };
            after = { name: ctx.body.name };
          } else if (ctx.path === '/change-password' && result?.user?.id === id) {
            action = 'user.password';
            before = {};
            after = { name: session.user.name };
          } else if (ctx.path === '/change-email' && result?.status === true) {
            const row = database.connection
              .prepare('SELECT email FROM user WHERE id = ?')
              .get(id) as { email: string } | undefined;
            if (!row || row.email !== ctx.body.newEmail || row.email === session.user.email) return;
            action = 'user.email';
            before = { email: session.user.email };
            after = { email: row.email };
          } else return;
          database.connection
            .transaction(() => {
              if (action === 'user.email')
                database.connection
                  .prepare('DELETE FROM session WHERE userId = ? AND id <> ?')
                  .run(id, session.session.id);
              recordAudit(database, {
                actor: id,
                action,
                subject: id,
                before,
                after,
                secretChanged: action === 'user.password',
              });
            })
            .immediate();
        }),
      },
      logger: { disabled: true },
    });
  }
  let auth = makeAuth();
  const migrations = await getMigrations(auth.options);
  await migrations.runMigrations();
  database.connection.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS user_email_case_insensitive ON user(email COLLATE NOCASE)',
  );

  // Written once by initialize(), so it is safe to keep in memory.
  let initialAdmin = (
    database.connection
      .prepare("SELECT value FROM app_meta WHERE key = 'initial_admin_id'")
      .get() as { value: string } | undefined
  )?.value;

  function userRow(id: string) {
    const row = database.connection
      .prepare('SELECT id, email, organizationEmail, name, role, banned FROM user WHERE id = ?')
      .get(id) as UserRow | undefined;
    if (!row) throw new HttpError(404, 'auth.userNotFound');
    return row;
  }
  function assertActiveAdmin(id: string) {
    const row = userRow(id);
    if (row.role !== 'admin' || row.banned)
      throw new HttpError(403, 'auth.administratorPermissionsHaveChanged');
  }

  function countUsers() {
    return (
      database.connection.prepare('SELECT COUNT(*) AS count FROM user').get() as { count: number }
    ).count;
  }
  function summary(row: UserRow): SessionUser {
    return {
      id: row.id,
      email: publicEmail(row.email) ?? publicEmail(row.organizationEmail),
      name: row.name,
      role: row.role === 'admin' ? 'admin' : 'user',
      enabled: !row.banned,
      hasLocalPassword: !!database.connection
        .prepare(
          "SELECT id FROM account WHERE userId = ? AND providerId = 'credential' AND password IS NOT NULL",
        )
        .get(row.id),
      isInitialAdmin: row.id === initialAdmin,
    };
  }
  function listUsers() {
    return (
      database.connection
        .prepare(
          'SELECT id, email, organizationEmail, name, role, banned FROM user ORDER BY createdAt, id',
        )
        .all() as UserRow[]
    ).map(summary);
  }
  async function currentUser(request: FastifyRequest): Promise<SessionUser | null> {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) return null;
    const row = database.connection
      .prepare('SELECT id, email, organizationEmail, name, role, banned FROM user WHERE id = ?')
      .get(session.user.id) as UserRow | undefined;
    return row && !row.banned ? summary(row) : null;
  }
  async function requireUser(request: FastifyRequest) {
    const user = await currentUser(request);
    if (!user) throw new HttpError(401, 'auth.signInFirst');
    return user;
  }
  async function requireAdmin(request: FastifyRequest) {
    const user = await requireUser(request);
    if (user.role !== 'admin')
      throw new HttpError(403, 'auth.onlyAdministratorsCanChangePlatformSettings');
    return user;
  }
  async function createUser(input: unknown, actor?: string) {
    const data = createUserSchema.parse(input);
    if (
      database.connection
        .prepare('SELECT id FROM user WHERE email = ? COLLATE NOCASE')
        .get(data.email)
    )
      throw new HttpError(409, 'auth.emailIsAlreadyInUse');
    const result = await auth.api.createUser({
      body: {
        email: data.email,
        name: data.name,
        password: data.password,
        role: data.role,
      },
    });
    if (!data.enabled)
      database.connection
        .prepare("UPDATE user SET banned = 1, banReason = '管理员停用' WHERE id = ?")
        .run(result.user.id);
    const user = listUsers().find((row) => row.id === result.user.id);
    if (!user) throw new Error('Created user was not found.');
    if (actor)
      recordAudit(database, {
        actor,
        action: 'user.create',
        subject: user.id,
        before: null,
        after: user,
        secretChanged: true,
      });
    return user;
  }
  let initializing = false;
  async function initialize(input: unknown, origin = '') {
    if (initializing || countUsers() !== 0)
      throw new HttpError(409, 'auth.administratorIsAlreadyInitialized');
    // Without a deployment URL, the address the platform was first opened at becomes its URL,
    // so the new administrator can sign in there.
    const publicUrl =
      origin && !config.publicUrl && !getTrustedOrigins().includes(origin)
        ? setupPublicUrl(origin)
        : undefined;
    initializing = true;
    try {
      const user = await createUser({
        ...createUserSchema.parse(input),
        role: 'admin',
        enabled: true,
      });
      database.connection
        .prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('initial_admin_id', ?)")
        .run(user.id);
      initialAdmin ??= user.id;
      if (publicUrl) {
        entra.recordInitialPublicUrl(publicUrl);
        auth = makeAuth();
      }
      return summary(userRow(user.id));
    } finally {
      initializing = false;
    }
  }
  function setupPublicUrl(origin: string) {
    try {
      return normalizePublicUrl(origin);
    } catch (error) {
      throw new HttpError(400, (error as Error).message as MessageKey);
    }
  }
  function assertRemainingAdmin(row: UserRow) {
    if (row.role !== 'admin' || row.banned) return;
    const count = (
      database.connection
        .prepare(
          "SELECT COUNT(*) AS count FROM user WHERE role = 'admin' AND (banned IS NULL OR banned = 0)",
        )
        .get() as { count: number }
    ).count;
    if (count <= 1) throw new HttpError(409, 'auth.activeAdminRequired');
    if (summary(row).hasLocalPassword) {
      const local = database.connection
        .prepare(
          "SELECT count(*) AS n FROM user WHERE role = 'admin' AND (banned IS NULL OR banned = 0) AND EXISTS (SELECT 1 FROM account WHERE account.userId = user.id AND providerId = 'credential' AND password IS NOT NULL)",
        )
        .get() as { n: number };
      if (local.n <= 1) throw new HttpError(409, 'auth.recoveryAdminRequired');
    }
  }
  function updateAccess(
    id: string,
    change: { role?: 'admin' | 'user'; enabled?: boolean },
    actor: SessionUser,
  ) {
    return database.connection
      .transaction(() => {
        assertActiveAdmin(actor.id);
        const row = userRow(id);
        const role = change.role ?? (row.role === 'admin' ? 'admin' : 'user');
        const enabled = change.enabled ?? !row.banned;
        if (id === initialAdmin && role !== 'admin')
          throw new HttpError(409, 'auth.initialLocalAdministratorSRoleCannotBeChanged');
        if (id === actor.id && !enabled)
          throw new HttpError(409, 'auth.youCannotDisableYourOwnAccount');
        if (id === actor.id && role !== row.role)
          throw new HttpError(409, 'auth.youCannotChangeYourOwnRole');
        if (role !== 'admin' || !enabled) assertRemainingAdmin(row);
        database.connection
          .prepare(
            'UPDATE user SET role = ?, banned = ?, banReason = ?, banExpires = NULL WHERE id = ?',
          )
          .run(role, enabled ? 0 : 1, enabled ? null : '管理员停用', id);
        if (row.role !== role || !enabled)
          database.connection.prepare('DELETE FROM session WHERE userId = ?').run(id);
        const after = summary({ ...row, role, banned: enabled ? 0 : 1 });
        recordAudit(database, {
          actor: actor.id,
          action: 'user.access',
          subject: id,
          before: summary(row),
          after,
        });
        return after;
      })
      .immediate();
  }

  function deleteUser(id: string, input: unknown, actor: SessionUser) {
    const { confirmation } = deleteUserSchema.parse(input);
    database.connection
      .transaction(() => {
        assertActiveAdmin(actor.id);
        const row = userRow(id);
        if (id === initialAdmin)
          throw new HttpError(409, 'auth.initialLocalAdministratorCannotBeDeleted');
        if (id === actor.id) throw new HttpError(409, 'auth.youCannotDeleteYourOwnAccount');
        assertRemainingAdmin(row);
        const before = summary(row);
        const expected = (before.email ?? before.name).trim();
        const matches = before.email
          ? confirmation.toLowerCase() === expected.toLowerCase()
          : confirmation === expected;
        if (!matches) throw new HttpError(400, 'auth.confirmationDoesNotMatchTheUserBeingDeleted');
        recordAudit(database, { actor: actor.id, action: 'user.delete', subject: id, before });
        // Only authentication records are removed. Business data and the audit trail remain.
        database.connection.prepare('DELETE FROM session WHERE userId = ?').run(id);
        database.connection.prepare('DELETE FROM account WHERE userId = ?').run(id);
        database.connection.prepare('DELETE FROM user WHERE id = ?').run(id);
      })
      .immediate();
  }

  async function editorSession(request: FastifyRequest, actor: SessionUser) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session || session.user.id !== actor.id) throw new HttpError(401, 'auth.signInFirst');
    return session.session.id;
  }
  function revokeEditedSessions(id: string, actorId: string, sessionId: string) {
    database.connection
      .prepare('DELETE FROM session WHERE userId = ? AND id <> ?')
      .run(id, id === actorId ? sessionId : '');
  }
  async function editUser(id: string, input: unknown, actor: SessionUser, request: FastifyRequest) {
    const data = editUserSchema.parse(input);
    const sessionId = await editorSession(request, actor);
    return database.connection
      .transaction(() => {
        assertActiveAdmin(actor.id);
        const row = userRow(id);
        const before = summary(row);
        if (!before.hasLocalPassword && data.email !== undefined)
          throw new HttpError(403, 'auth.organizationEmailIsManagedByMicrosoftEntraID');
        const email = data.email ?? row.email;
        if (
          database.connection
            .prepare('SELECT id FROM user WHERE email = ? COLLATE NOCASE AND id <> ?')
            .get(email, id)
        )
          throw new HttpError(409, 'auth.emailIsAlreadyInUse');
        database.connection
          .prepare(
            'UPDATE user SET name = ?, email = ?, emailVerified = CASE WHEN email = ? THEN emailVerified ELSE 0 END, updatedAt = ? WHERE id = ?',
          )
          .run(data.name, email, email, Date.now(), id);
        if (email !== row.email) revokeEditedSessions(id, actor.id, sessionId);
        const after = summary(userRow(id));
        recordAudit(database, {
          actor: actor.id,
          action: 'user.profile',
          subject: id,
          before,
          after,
        });
        return after;
      })
      .immediate();
  }
  async function resetUserPassword(
    id: string,
    input: unknown,
    actor: SessionUser,
    request: FastifyRequest,
  ) {
    const data = resetUserPasswordSchema.parse(input);
    const sessionId = await editorSession(request, actor);
    if (!summary(userRow(id)).hasLocalPassword)
      throw new HttpError(403, 'auth.organizationPasswordsAreManagedByMicrosoftEntraID');
    const password = await hashPassword(data.newPassword);
    database.connection
      .transaction(() => {
        // Hashing yields; recheck authority and the target inside the write transaction.
        assertActiveAdmin(actor.id);
        if (!summary(userRow(id)).hasLocalPassword)
          throw new HttpError(403, 'auth.organizationPasswordsAreManagedByMicrosoftEntraID');
        database.connection
          .prepare(
            "UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'",
          )
          .run(password, Date.now(), id);
        revokeEditedSessions(id, actor.id, sessionId);
        recordAudit(database, {
          actor: actor.id,
          action: 'user.password_reset',
          subject: id,
          before: null,
          after: summary(userRow(id)),
          secretChanged: true,
        });
      })
      .immediate();
  }

  return {
    get auth() {
      return auth;
    },
    reloadProviders() {
      auth = makeAuth();
    },
    get origin() {
      return getOrigin();
    },
    get trustedOrigins() {
      return getTrustedOrigins();
    },
    countUsers,
    currentUser,
    requireUser,
    requireAdmin,
    createUser,
    initialize,
    listUsers,
    updateAccess,
    editUser,
    resetUserPassword,
    deleteUser,
    /** Until an administrator exists, setup is open to any address unless the deployment fixes one. */
    acceptsFirstSetup() {
      return countUsers() === 0 && !config.publicUrl;
    },
  };
}

export type AuthService = Awaited<ReturnType<typeof createAuthService>>;
