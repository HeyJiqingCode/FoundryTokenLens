import { importJWK, type JWK, type JWTHeaderParameters } from 'jose';

// Microsoft JWKS may omit alg. Pin RS256 rather than relying on that optional field.
export async function entraSigningKey(tenantId: string, header: JWTHeaderParameters) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId) ||
    header.alg !== 'RS256' ||
    typeof header.kid !== 'string'
  )
    throw new Error('Invalid Entra signing key request');
  const response = await fetch(
    `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    { signal: AbortSignal.timeout(10000), redirect: 'error' },
  );
  if (!response.ok) throw new Error('Entra signing keys unavailable');
  const data = (await response.json()) as { keys?: (JWK & { issuer?: string })[] };
  const key = data.keys?.find((item) => item.kid === header.kid);
  if (
    !key ||
    key.kty !== 'RSA' ||
    (key.use && key.use !== 'sig') ||
    (key.alg && key.alg !== 'RS256')
  )
    throw new Error('Entra signing key not found');
  if (
    key.issuer?.replace('{tenantid}', tenantId) !==
    `https://login.microsoftonline.com/${tenantId}/v2.0`
  )
    throw new Error('Entra signing key issuer mismatch');
  return importJWK(key, 'RS256');
}
