import { z } from 'zod';
import { LOG_EVENT_TYPES, LOG_LEVELS } from '../../shared/platform.js';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/service.js';
import type { ImportWorker } from '../ingestion/worker.js';
import type { createPlatformService } from './service.js';

export function registerPlatformRoutes(
  app: FastifyInstance,
  auth: AuthService,
  platform: ReturnType<typeof createPlatformService>,
  worker: ImportWorker,
) {
  function reclaimSpace() {
    try {
      platform.reclaimSpace();
      return true;
    } catch (error) {
      app.log.warn({ err: error }, 'Data cleared, but SQLite space reclamation failed.');
      return false;
    }
  }
  app.get('/api/platform/log-policy', async (request) => {
    await auth.requireAdmin(request);
    return platform.logPolicy();
  });
  app.put('/api/platform/log-policy', async (request) => {
    const actor = await auth.requireAdmin(request);
    const policy = z
      .object({
        maxSizeMiB: z.number().int().min(1).max(10240),
        retentionDays: z.number().int().min(1).max(3650),
        eventTypes: z
          .array(z.enum(LOG_EVENT_TYPES))
          .max(LOG_EVENT_TYPES.length)
          .transform((values) => [...new Set(values)]),
        levels: z
          .array(z.enum(LOG_LEVELS))
          .max(LOG_LEVELS.length)
          .transform((values) => [...new Set(values)]),
      })
      .strict()
      .parse(request.body);
    return platform.saveLogPolicy(policy, actor.name);
  });
  app.get('/api/platform/system-data', async (request) => {
    await auth.requireUser(request);
    return platform.data();
  });
  app.get('/api/platform/logs', async (request) => {
    await auth.requireAdmin(request);
    const filters = z
      .object({
        category: z.enum(['task', 'operation', 'system']).optional(),
        level: z.enum(['info', 'warning', 'error']).optional(),
        search: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).max(10000000).default(0),
      })
      .parse(request.query);
    return platform.logs(filters);
  });
  app.post('/api/platform/clear-system-logs', async (request) => {
    await auth.requireAdmin(request);
    z.object({ confirmation: z.literal('clear-system-logs') })
      .strict()
      .parse(request.body);
    platform.clearLogs();
    return { cleared: true, spaceReclaimed: reclaimSpace() };
  });
  app.post('/api/platform/clear-log-data', async (request) => {
    const actor = await auth.requireAdmin(request);
    z.object({ confirmation: z.literal('clear-log-data') })
      .strict()
      .parse(request.body);
    await worker.clearLogData(actor.id);
    platform.flush();
    const spaceReclaimed = reclaimSpace();
    return { ...platform.data(), spaceReclaimed };
  });
}
