import { recordAudit } from '../platform/audit-format.js';
import { z } from 'zod';
import type { AppDatabase } from '../database.js';
import type { SecretStore } from '../security/secrets.js';
import type { EntraSettings } from '../../shared/settings.js';
import { HttpError } from '../http/errors.js';
import type { AppConfig } from '../config.js';
import { microsoftCallbackUrl, normalizePublicUrl } from '../../shared/public-url.js';

const consumerTenant = '9188040d-6c67-4c5b-b112-36a304b66dad';
const tenantIdSchema = z
  .string()
  .trim()
  .uuid('auth.enterAValidTenantID')
  .transform((value) => value.toLowerCase())
  .refine((value) => value !== consumerTenant, 'auth.onlyEntraOrganizationTenantsAreSupported');

export const entraSchema = z
  .object({
    enabled: z.boolean(),
    defaultAdmin: z.boolean().default(false),
    allowedTenantIds: z
      .array(tenantIdSchema)
      .max(20, 'auth.youCanEnterUpTo20Tenants')
      .transform((values) => [...new Set(values)]),
    clientId: z.string().uuid(),
    clientSecret: z.string().max(4096).optional(),
    useSavedSecret: z.boolean().optional(),
    publicUrl: z
      .string()
      .max(2048)
      .transform((value, context) => {
        try {
          return normalizePublicUrl(value);
        } catch (error) {
          context.addIssue({
            code: 'custom',
            message: error instanceof Error ? error.message : 'auth.invalidPlatformURL',
          });
          return z.NEVER;
        }
      })
      .optional(),
  })
  .strict()
  .refine((value) => !value.enabled || value.allowedTenantIds.length > 0, {
    path: ['allowedTenantIds'],
    message: 'auth.enterAtLeastOneAllowedTenantID',
  });
interface StoredEntra {
  enabled: boolean;
  defaultAdmin?: boolean;
  allowedTenantIds: string[];
  clientId: string;
  encryptedSecret: string;
  updatedAt: string;
  publicUrl?: string;
}
export type EntraVerifier = (tenantId: string) => Promise<void>;
export const verifyEntraTenant: EntraVerifier = async (tenantId) => {
  try {
    const url = `https://login.microsoftonline.com/${tenantId}/v2.0/.well-known/openid-configuration`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error('Discovery failed');
    const data = (await response.json()) as { issuer?: string };
    if (data.issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0`)
      throw new Error('Issuer mismatch');
  } catch {
    throw new HttpError(400, 'auth.cannotVerifyTheEntraTenant');
  }
};

export function createEntraRepository(
  database: AppDatabase,
  secrets: SecretStore,
  config: AppConfig,
) {
  const db = database.connection;
  function stored(): StoredEntra | null {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = 'entra'").get() as
      { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : null;
  }
  // The address the platform was first opened at, recorded by setup without a deployment URL.
  function initialPublicUrl() {
    return (
      db.prepare("SELECT value FROM app_meta WHERE key = 'initial_public_url'").get() as
        { value: string } | undefined
    )?.value;
  }
  function recordInitialPublicUrl(url: string) {
    db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('initial_public_url', ?)").run(
      url,
    );
  }
  function get(): EntraSettings {
    const value = stored();
    const savedUrl = value?.publicUrl ?? initialPublicUrl();
    const publicUrl = normalizePublicUrl(
      config.publicUrl ?? savedUrl ?? config.defaultPublicUrl ?? `http://localhost:${config.port}`,
    );
    return {
      enabled: Boolean(value?.enabled && value.allowedTenantIds?.length),
      defaultAdmin: value?.defaultAdmin ?? false,
      allowedTenantIds: value?.allowedTenantIds ?? [],
      clientId: value?.clientId ?? '',
      hasSecret: !!value?.encryptedSecret,
      updatedAt: value?.updatedAt ?? null,
      publicUrl,
      publicUrlSource: config.publicUrl ? 'environment' : savedUrl ? 'settings' : 'default',
      callbackUrl: microsoftCallbackUrl(publicUrl),
    };
  }
  function credentials() {
    const value = stored();
    return value?.enabled && value.allowedTenantIds?.length
      ? {
          tenantId: 'organizations',
          clientId: value.clientId,
          clientSecret: secrets.decrypt(value.encryptedSecret),
        }
      : null;
  }
  function allowsTenant(tenantId: unknown) {
    const parsed = tenantIdSchema.safeParse(tenantId);
    const value = stored();
    if (!parsed.success || !value?.enabled) return false;
    return (value.allowedTenantIds ?? []).includes(parsed.data);
  }
  function save(input: z.infer<typeof entraSchema>, actor: string) {
    const previous = stored();
    if (
      config.publicUrl &&
      input.publicUrl !== undefined &&
      input.publicUrl !== normalizePublicUrl(config.publicUrl)
    ) {
      throw new HttpError(409, 'auth.platformURLIsManagedByFTLPUBLICURL');
    }
    const secret =
      input.clientSecret ||
      (input.useSavedSecret && previous?.clientId === input.clientId
        ? secrets.decrypt(previous.encryptedSecret)
        : '');
    if (!secret) throw new HttpError(400, 'auth.enterAClientSecret');
    db.transaction(() => {
      const before = get();
      const value: StoredEntra = {
        enabled: input.enabled,
        defaultAdmin: input.defaultAdmin,
        allowedTenantIds: input.allowedTenantIds,
        clientId: input.clientId.toLowerCase(),
        encryptedSecret: secrets.encrypt(secret),
        updatedAt: new Date().toISOString(),
        publicUrl: config.publicUrl
          ? previous?.publicUrl
          : (input.publicUrl ?? previous?.publicUrl),
      };
      db.prepare(
        "INSERT INTO settings VALUES ('entra', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      ).run(JSON.stringify(value), value.updatedAt);
      recordAudit(database, {
        actor,
        action: 'entra.update',
        subject: 'entra',
        before,
        after: get(),
        secretChanged: Boolean(input.clientSecret),
      });
      db.prepare(
        "DELETE FROM session WHERE userId IN (SELECT userId FROM account WHERE providerId = 'microsoft')",
      ).run();
    }).immediate();
    return get();
  }
  function setEnabled(enabled: boolean, actor: string) {
    const previous = stored();
    if (!previous) throw new HttpError(409, 'auth.saveEntraFirst');
    if (
      enabled &&
      (!previous.encryptedSecret || !previous.clientId || !previous.allowedTenantIds?.length)
    )
      throw new HttpError(409, 'auth.saveEntraFirst');
    const value = { ...previous, enabled, updatedAt: new Date().toISOString() };
    db.transaction(() => {
      const before = get();
      db.prepare("UPDATE settings SET value_json=?,updated_at=? WHERE key='entra'").run(
        JSON.stringify(value),
        value.updatedAt,
      );
      recordAudit(database, {
        actor,
        action: 'entra.status',
        subject: 'entra',
        before,
        after: get(),
      });
    }).immediate();
    return get();
  }
  return { get, credentials, save, allowsTenant, setEnabled, recordInitialPublicUrl };
}
export type EntraRepository = ReturnType<typeof createEntraRepository>;
