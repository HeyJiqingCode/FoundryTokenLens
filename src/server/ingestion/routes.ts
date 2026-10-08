import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import type { ImportWorker } from './worker.js';
import type { SettingsRepository } from '../settings/repository.js';
import { HttpError } from '../http/errors.js';

export function registerIngestionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  worker: ImportWorker,
  settings: SettingsRepository,
) {
  app.get('/api/ingestion', async (request) => {
    await auth.requireUser(request);
    return worker.status();
  });
  app.post('/api/settings/tasks/reset-history', async (request) => {
    const actor = await auth.requireAdmin(request);
    z.object({ confirmation: z.literal('reset-task-history') })
      .strict()
      .parse(request.body);
    return { tasks: await worker.resetHistory(actor.id) };
  });
  app.post('/api/ingestion/run', async (request, reply) => {
    const actor = await auth.requireAdmin(request);
    const { mode, sourceIds } = z
      .object({
        mode: z.enum(['scan', 'reconcile']),
        sourceIds: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, 'schedule.duplicateSource')
          .optional(),
      })
      .strict()
      .parse(request.body);
    const enabled = settings.getSources().filter((source) => source.enabled);
    const selected = sourceIds
      ? enabled.filter((source) => sourceIds.includes(source.id))
      : enabled;
    if (sourceIds && selected.length !== sourceIds.length)
      throw new HttpError(409, 'ingestion.selectedSourcesUnavailable');
    if (worker.running) throw new HttpError(409, 'ingestion.taskIsRunning');
    return reply.code(202).send(worker.request(mode, true, selected, undefined, actor.name));
  });
  app.get('/api/requests/evidence', async (request) => {
    await auth.requireUser(request);
    const { resourceId, correlationId } = z
      .object({
        resourceId: z.string().min(1).max(2048),
        correlationId: z.string().min(1).max(512),
      })
      .parse(request.query);
    return { records: worker.evidence(resourceId, correlationId) };
  });
}
