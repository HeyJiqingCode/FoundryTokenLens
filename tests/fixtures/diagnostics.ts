// Synthetic records only. No customer resource identifiers, credentials, or prompts.
import type { BlobItem, BlobReader } from '../../src/server/ingestion/blob-reader.js';
import { LOG_CONTAINERS } from '../../src/shared/settings.js';

export const resource =
  '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/synthetic/providers/Microsoft.CognitiveServices/accounts/fixture';
export const now = new Date('2026-09-20T02:00:00.000Z');
export const containers = LOG_CONTAINERS.map((x) => x.name);
export const path = (hour = '02', day = '20', id = resource) =>
  `resourceId=${id.toUpperCase()}/y=2026/m=09/d=${day}/h=${hour}/m=00/PT1H.json`;
export function usage(id: string, properties: Record<string, unknown> = {}, resourceId = resource) {
  return {
    time: now.toISOString(),
    resourceId,
    category: 'AzureOpenAIRequestUsage',
    correlationId: id,
    operationName: 'create-response',
    properties: JSON.stringify({
      modelName: 'synthetic-model',
      modelVersion: 'v1',
      promptTokens: [120],
      generatedTokens: 30,
      cachedTokens: 10,
      ...properties,
    }),
  };
}
export function response(id: string, durationMs = 100, status = 200) {
  return {
    time: now.toISOString(),
    resourceId: resource,
    category: 'RequestResponse',
    correlationId: id,
    operationName: 'create-response',
    durationMs,
    resultSignature: String(status),
    callerIpAddress: '192.0.2.1',
    properties: { promptTokens: durationMs ? 120 : 0, completionTokens: durationMs ? 30 : 0 },
  };
}
export class SyntheticBlobReader implements BlobReader {
  blobs = new Map<string, { item: BlobItem; body: Buffer }>();
  reads: { container: string; name: string; offset: number }[] = [];
  listings: { container: string; prefix: string; marker?: string }[] = [];
  failRead = false;
  failList = false;
  holdRead: Promise<void> | null = null;
  pageSize = 100;
  put(
    container: string,
    name: string,
    records: unknown[] | string,
    options: Partial<BlobItem> = {},
  ) {
    const previous = this.blobs.get(`${container}/${name}`);
    const body = Buffer.from(
      typeof records === 'string'
        ? records
        : records.map((x) => JSON.stringify(x)).join('\n') + '\n',
    );
    const item: BlobItem = {
      name,
      size: body.length,
      etag: `"${Number(previous?.item.etag.replaceAll('"', '') ?? 0) + 1}"`,
      blobType: 'AppendBlob',
      createdOn: '2026-09-20T00:00:00.000Z',
      ...options,
    };
    this.blobs.set(`${container}/${name}`, { item, body });
  }
  async list(container: string, prefix: string, marker: string | undefined, signal: AbortSignal) {
    signal.throwIfAborted();
    this.listings.push({ container, prefix, marker });
    if (this.failList) throw new Error('synthetic failure; secret must never escape');
    const all = [...this.blobs.entries()]
      .filter(([key, x]) => key.startsWith(`${container}/`) && x.item.name.startsWith(prefix))
      .map(([, x]) => x.item)
      .sort((a, b) => a.name.localeCompare(b.name));
    const start = Number(marker ?? 0);
    return {
      items: all.slice(start, start + this.pageSize),
      marker: start + this.pageSize < all.length ? String(start + this.pageSize) : null,
    };
  }
  async read(
    container: string,
    name: string,
    offset: number,
    count: number,
    etag: string,
    signal: AbortSignal,
  ) {
    this.reads.push({ container, name, offset });
    if (this.holdRead) await this.holdRead;
    signal.throwIfAborted();
    if (this.failRead) throw new Error('synthetic failure; secret must never escape');
    const blob = this.blobs.get(`${container}/${name}`)!;
    if (blob.item.etag !== etag) throw Object.assign(new Error('Changed'), { statusCode: 412 });
    return blob.body.subarray(offset, offset + count);
  }
}
