import { createBlobClient, type ResolvedSource } from '../sources/azure-blob.js';
import type {
  BlobItem as AzureBlobItem,
  ContainerListBlobFlatSegmentResponse,
} from '@azure/storage-blob';

export interface BlobItem {
  name: string;
  etag: string;
  size: number;
  blobType: string;
  createdOn: string | null;
}
export interface BlobReader {
  list(
    container: string,
    prefix: string,
    marker: string | undefined,
    signal: AbortSignal,
  ): Promise<{ items: BlobItem[]; marker: string | null }>;
  read(
    container: string,
    name: string,
    offset: number,
    count: number,
    etag: string,
    signal: AbortSignal,
  ): Promise<Buffer>;
}
export type BlobReaderFactory = (source: ResolvedSource) => BlobReader;

/** A download fails only after this long without receiving any data. */
const DOWNLOAD_IDLE_MS = 30_000;

export const azureBlobReader = (
  source: ResolvedSource,
  idleTimeoutMs = DOWNLOAD_IDLE_MS,
): BlobReader => {
  const client = createBlobClient(source);
  return {
    async list(container, prefix, marker, signal) {
      const page = await client
        .getContainerClient(container)
        .listBlobsFlat({
          prefix,
          abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        })
        .byPage({ continuationToken: marker, maxPageSize: 100 })
        .next();
      const result = page.value as ContainerListBlobFlatSegmentResponse | undefined;
      return {
        marker: result?.continuationToken || null,
        items: (result?.segment.blobItems ?? []).map((blob: AzureBlobItem) => ({
          name: blob.name,
          etag: blob.properties.etag ?? '',
          size: blob.properties.contentLength ?? 0,
          blobType: blob.properties.blobType ?? '',
          createdOn: blob.properties.createdOn?.toISOString() ?? null,
        })),
      };
    },
    async read(container, name, offset, count, etag, signal) {
      if (!count) return Buffer.alloc(0);
      // A slow link is fine while data keeps arriving; only a stalled download is aborted.
      const idle = new AbortController();
      let timer = setTimeout(() => idle.abort(), idleTimeoutMs);
      const progressed = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), idleTimeoutMs);
      };
      try {
        const response = await client
          .getContainerClient(container)
          .getBlobClient(name)
          .download(offset, count, {
            conditions: { ifMatch: etag },
            abortSignal: AbortSignal.any([signal, idle.signal]),
            maxRetryRequests: 0,
          });
        if (!response.readableStreamBody) throw new Error('Blob 未返回可读内容');
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of response.readableStreamBody as AsyncIterable<Buffer>) {
          progressed();
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > count) throw new Error('Blob 读取超出请求范围');
          chunks.push(buffer);
        }
        if (bytes !== count) throw new Error('Blob 内容未完整读取');
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
