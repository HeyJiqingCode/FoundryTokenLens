import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { verifyProviderIdToken } from 'better-auth/oauth2';
import { microsoft } from 'better-auth/social-providers';
import type { EntraRepository } from './entra.js';
import { ENTRA_LOGIN_ERRORS } from '../../shared/entra-errors.js';
import { entraSigningKey } from './entra-keys.js';

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function rejectLogin(code: keyof typeof ENTRA_LOGIN_ERRORS): never {
  throw new APIError('FORBIDDEN', { code, message: ENTRA_LOGIN_ERRORS[code] });
}

// Add tenant admission and tenant-scoped identities to the built-in OAuth provider.
export function entraTenantAccess(entra: EntraRepository): BetterAuthPlugin {
  return {
    id: 'entra-tenant-access',
    init(context) {
      const provider = context.socialProviders.find((item) => item.id === 'microsoft');
      const credentials = entra.credentials();
      if (!provider || !credentials) return;
      const configurationRevision = entra.get().updatedAt;
      const createAuthorizationURL = provider.createAuthorizationURL;
      const getUserInfo = provider.getUserInfo;
      provider.requiresIdTokenNonce = true;
      provider.createAuthorizationURL = async (input) => {
        const url = await createAuthorizationURL(input);
        if (input.idTokenNonce) url.searchParams.set('nonce', input.idTokenNonce);
        return url;
      };
      provider.getUserInfo = async (tokens) => {
        if (!tokens.expectedIdTokenNonce) rejectLogin('ENTRA_LOGIN_EXPIRED');
        if (!tokens.idToken) rejectLogin('ENTRA_TOKEN_MISSING');
        let claims: { tid?: unknown; oid?: unknown; exp?: unknown };
        try {
          claims = JSON.parse(Buffer.from(tokens.idToken.split('.')[1], 'base64url').toString());
        } catch {
          rejectLogin('ENTRA_TOKEN_INVALID');
        }
        if (
          typeof claims?.tid !== 'string' ||
          !guid.test(claims.tid) ||
          typeof claims.exp !== 'number'
        )
          rejectLogin('ENTRA_TOKEN_INVALID');
        // Before verification, tid only selects a fixed Microsoft key endpoint.
        // Never use decoded claims alone to create an account or authorize access.
        const verifier = microsoft({ clientId: credentials.clientId, tenantId: claims.tid });
        const valid = await verifyProviderIdToken(
          {
            idToken: {
              ...verifier.idToken,
              algorithms: ['RS256'],
              jwks: (header) => entraSigningKey(claims.tid as string, header),
            },
          },
          tokens.idToken,
          tokens.expectedIdTokenNonce,
        );
        if (!valid) rejectLogin('ENTRA_TOKEN_INVALID');
        if (typeof claims.oid !== 'string' || !guid.test(claims.oid))
          rejectLogin('ENTRA_PROFILE_INVALID');
        if (!entra.allowsTenant(claims.tid)) rejectLogin('ENTRA_TENANT_NOT_ALLOWED');
        // Do not complete a login that began with superseded settings.
        if (entra.get().updatedAt !== configurationRevision) rejectLogin('ENTRA_SETTINGS_CHANGED');
        return getUserInfo(tokens);
      };
      provider.accountSubject = ({ profile }) => {
        const claims = profile as { tid?: unknown; oid?: unknown };
        if (
          !entra.allowsTenant(claims.tid) ||
          typeof claims.oid !== 'string' ||
          !guid.test(claims.oid)
        )
          throw new Error('Entra identity is not allowed');
        return `${String(claims.tid).toLowerCase()}.${claims.oid.toLowerCase()}`;
      };
    },
  };
}
