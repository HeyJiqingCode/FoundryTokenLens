import { ManagedIdentityCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { LOG_CONTAINERS, type SourceInspection } from '../../shared/settings.js';
import { HttpError } from '../http/errors.js';

export type ResolvedSource = {
  authMode: 'connection_string' | 'managed_identity';
  connectionString: string;
  endpoint: string;
  managedIdentityClientId: string;
};
export interface SourceInspector {
  inspect(source: ResolvedSource): Promise<SourceInspection>;
}
const azureSuffixes = [
  '.blob.core.windows.net',
  '.blob.core.chinacloudapi.cn',
  '.blob.core.usgovcloudapi.net',
];

export function normalizeManagedIdentityEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'sources.enterTheFullBlobEndpoint');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    !azureSuffixes.some(
      (suffix) =>
        url.hostname.endsWith(suffix) &&
        /^[a-z0-9]{3,24}$/.test(url.hostname.slice(0, -suffix.length)),
    )
  ) {
    throw new HttpError(400, 'sources.managedIdentityRequiresAValidAzureStorageHTTPS');
  }
  return url.origin;
}

export function createBlobClient(source: ResolvedSource) {
  const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: 10000 } };
  if (source.authMode === 'managed_identity') {
    const endpoint = normalizeManagedIdentityEndpoint(source.endpoint);
    const credential = source.managedIdentityClientId
      ? new ManagedIdentityCredential({ clientId: source.managedIdentityClientId })
      : new ManagedIdentityCredential();
    return new BlobServiceClient(endpoint, credential, options);
  }
  let client: BlobServiceClient;
  try {
    client = BlobServiceClient.fromConnectionString(source.connectionString, options);
  } catch {
    throw new HttpError(400, 'sources.invalidConnectionStringFormat');
  }
  const url = new URL(client.url);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new HttpError(400, 'sources.cloudBlobConnectionsMustUseHTTPS');
  }
  return client;
}

export const azureBlobInspector: SourceInspector = {
  async inspect(source) {
    try {
      const client = createBlobClient(source);
      const abortSignal = AbortSignal.timeout(15000);
      const available: SourceInspection['containers'] = [];
      let permissionDenied = false;
      let dataRoleMissing = false;
      // Known diagnostic containers can be probed without account-wide List permission.
      for (const item of LOG_CONTAINERS) {
        const container = client.getContainerClient(item.name);
        try {
          await container.getProperties({ abortSignal });
          await container.listBlobsFlat({ abortSignal }).byPage({ maxPageSize: 1 }).next();
          available.push({ ...item });
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404) continue;
          if (status === 403) {
            permissionDenied = true;
            // Signed in, but without a Blob data role (or a SAS without read and list).
            if ((error as { code?: string }).code === 'AuthorizationPermissionMismatch')
              dataRoleMissing = true;
            continue;
          }
          throw error;
        }
      }
      if (!available.length && permissionDenied)
        throw new HttpError(
          400,
          dataRoleMissing ? 'sources.blobDataPermissionMissing' : 'sources.containerAccessFailed',
        );
      const endpoint = new URL(client.url);
      endpoint.search = '';
      endpoint.hash = '';
      return {
        endpoint: endpoint.toString().replace(/\/$/, ''),
        accountName: client.accountName,
        containers: available,
        verifiedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 401 || status === 403)
        throw new HttpError(400, 'sources.containerCredentialsFailed');
      if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError')
        throw new HttpError(408, 'sources.connectionTimedOut');
      if (source.authMode === 'managed_identity')
        throw new HttpError(400, 'sources.managedIdentityAuthenticationFailed');
      throw new HttpError(400, 'sources.connectionFailed');
    }
  },
};
