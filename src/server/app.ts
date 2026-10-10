import { createPlatformService } from './platform/service.js';
import { registerPlatformRoutes } from './platform/routes.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { BootstrapResponse } from '../shared/navigation.js';
import type { AppConfig } from './config.js';
import { openDatabase } from './database.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createAuthService } from './auth/service.js';
import { registerErrors } from './http/errors.js';
import { createSecretStore } from './security/secrets.js';
import { createSettingsRepository } from './settings/repository.js';
import {
  createSourceStatistics,
  type SourceStatisticsService,
} from './settings/source-statistics.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { azureBlobInspector, type SourceInspector } from './sources/azure-blob.js';
import { createImportWorker, type ImportWorker } from './ingestion/worker.js';
import type { BlobReaderFactory } from './ingestion/blob-reader.js';
import { registerIngestionRoutes } from './ingestion/routes.js';
import { createEntraRepository, type EntraRepository, type EntraVerifier } from './auth/entra.js';
import { createPricingService, type PricingService } from './pricing/service.js';
import { registerPricingRoutes } from './pricing/routes.js';
import type { RetailFetcher } from './pricing/retail.js';
import { createAnalyticsService } from './analytics/service.js';
import { registerAnalyticsRoutes } from './analytics/routes.js';

// Same relative path from src/server and dist/server.
const APP_VERSION = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export async function buildApp(
  config: AppConfig,
  logger = false,
  dependencies: {
    sourceInspector?: SourceInspector;
    blobReader?: BlobReaderFactory;
    workerEnabled?: boolean;
    entraVerifier?: EntraVerifier;
    retailFetcher?: RetailFetcher;
  } = {},
) {
  const app = Fastify({
    logger: logger
      ? {
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          serializers: {
            req: (request: { method?: string; url?: string }) => ({
              method: request.method,
              url: request.url?.split('?')[0],
            }),
          },
        }
      : false,
  });
  // Reports are large JSON, sent again every minute; static files gain too, so this comes first.
  // Only responses: no route takes compressed request bodies.
  await app.register(fastifyCompress, { globalDecompression: false });
  const database = openDatabase(config.dataDir);
  let logCleanup: ReturnType<typeof setInterval> | undefined;
  let worker: ImportWorker | undefined;
  let pricing: PricingService | undefined;
  let sourceStatistics: SourceStatisticsService | undefined;
  app.addHook('onClose', async () => {
    clearInterval(logCleanup);
    await worker?.stop();
    await pricing?.stop();
    await sourceStatistics?.stop();
    database.close();
  });
  registerErrors(app);
  let auth: Awaited<ReturnType<typeof createAuthService>>;
  let secrets: ReturnType<typeof createSecretStore>;
  let entra: EntraRepository;
  try {
    const hasSource = Boolean(
      database.connection
        .prepare("SELECT key FROM settings WHERE key IN ('sources', 'entra') LIMIT 1")
        .get(),
    );
    secrets = createSecretStore(config.dataDir, config.secretKey, hasSource);
    entra = createEntraRepository(database, secrets, config);
    auth = await createAuthService(database, config, secrets.authSecret, entra);
  } catch (error) {
    await app.close();
    throw error;
  }
  const repository = createSettingsRepository(database, secrets);
  const platform = createPlatformService(database, repository);
  pricing = createPricingService(database, repository, dependencies.retailFetcher);
  sourceStatistics = createSourceStatistics(database, repository, dependencies.blobReader);
  worker = createImportWorker(
    database,
    repository,
    dependencies.blobReader,
    undefined,
    sourceStatistics.refresh,
    () => platform.flush(),
  );
  registerAuthRoutes(app, auth, entra, dependencies.entraVerifier);
  registerIngestionRoutes(app, auth, worker, repository);
  registerPricingRoutes(app, auth, pricing);
  const analytics = createAnalyticsService(database, repository);
  registerAnalyticsRoutes(app, auth, analytics);
  registerPlatformRoutes(app, auth, platform, worker);
  app.addHook('onReady', async () => {
    platform.flush();
    database.logs.prune(true);
    logCleanup = setInterval(() => {
      try {
        database.logs.prune();
      } catch {
        app.log.error('System log retention cleanup failed.');
      }
    }, 60000);
    logCleanup.unref();
  });
  if (dependencies.workerEnabled)
    app.addHook('onReady', async () => {
      worker!.start();
      pricing!.start((error) => app.log.error({ err: error }, 'Cost calculation failed.'));
    });
  registerSettingsRoutes(
    app,
    auth,
    database,
    repository,
    dependencies.sourceInspector ?? azureBlobInspector,
    sourceStatistics,
    pricing,
  );

  app.get('/api/health', async () => {
    database.connection.prepare('SELECT 1').get();
    return { status: 'ok', version: APP_VERSION };
  });

  app.get('/api/bootstrap', async (request): Promise<BootstrapResponse> => {
    await auth.requireUser(request);
    return {
      version: APP_VERSION,
      dataStatus: repository.getSources().some((source) => source.enabled)
        ? 'configured'
        : 'not_connected',
    };
  });

  const hasFrontend = existsSync(join(config.webDir, 'index.html'));
  if (hasFrontend) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    const isAsset = pathname.startsWith('/assets/') || pathname.split('/').at(-1)?.includes('.');
    if (
      hasFrontend &&
      !isApi &&
      !isAsset &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return reply
        .header('Cache-Control', 'no-cache')
        .sendFile('index.html', { cacheControl: false });
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return app;
}
