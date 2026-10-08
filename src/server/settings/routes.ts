import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import type { AppDatabase } from '../database.js';
import type { SourceInspector } from '../sources/azure-blob.js';
import type { SettingsRepository } from './repository.js';
import {
  priceCorrectionSchema,
  priceSchema,
  sourceSchema,
  scheduledTaskSchema,
} from './validation.js';
import { HttpError } from '../http/errors.js';
import type { PricingService } from '../pricing/service.js';
import { changedPeriod } from '../pricing/models.js';
import { LOG_CONTAINERS, type SourceInput } from '../../shared/settings.js';
import type { SourceStatisticsService } from './source-statistics.js';

export function registerSettingsRoutes(
  app: FastifyInstance,
  auth: AuthService,
  database: AppDatabase,
  repository: SettingsRepository,
  inspector: SourceInspector,
  sourceStatistics: SourceStatisticsService,
  pricing?: PricingService,
) {
  /** Saves only the supported containers the inspection actually found. */
  async function inspectSource(input: SourceInput, id?: string) {
    const resolved = repository.resolveSource(input, id);
    const inspection = await inspector.inspect(resolved);
    input.containers = LOG_CONTAINERS.filter((item) =>
      inspection.containers.some((found) => found.name === item.name),
    ).map((item) => item.name);
    if (!input.containers.length)
      throw new HttpError(400, 'sources.connectedButNoSupportedDiagnosticLogContainersWere');
    return { resolved, inspection };
  }
  app.get('/api/settings/tasks', async (request) => {
    await auth.requireAdmin(request);
    return { tasks: repository.listTasks() };
  });
  app.post('/api/settings/tasks', async (request, reply) => {
    const user = await auth.requireAdmin(request);
    return reply
      .code(201)
      .send({ task: repository.saveTask(scheduledTaskSchema.parse(request.body), user.id) });
  });
  app.put('/api/settings/tasks/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    return { task: repository.saveTask(scheduledTaskSchema.parse(request.body), user.id, id) };
  });
  app.patch('/api/settings/tasks/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    const task = repository.getTasks().find((task) => task.id === id);
    if (!task) throw new HttpError(404, 'schedule.taskNotFound');
    const { id: _id, updatedAt: _updated, ...input } = task;
    return { task: repository.saveTask({ ...input, enabled }, user.id, id) };
  });
  app.delete('/api/settings/tasks/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    repository.deleteTask(id, user.id);
    return { deleted: true };
  });
  app.get('/api/settings/sources', async (request) => {
    await auth.requireAdmin(request);
    return { sources: repository.getSources() };
  });
  app.get('/api/settings/sources/:id/statistics', async (request) => {
    await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    return { statistics: sourceStatistics.read(id) };
  });
  app.post('/api/settings/sources/:id/statistics/refresh', async (request) => {
    await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    return { statistics: await sourceStatistics.refresh(id) };
  });
  app.post('/api/settings/source/test', async (request) => {
    await auth.requireAdmin(request);
    const input = sourceSchema.parse(request.body);
    const { sourceId } = z
      .object({ sourceId: z.string().min(1).max(128).optional() })
      .parse(request.query);
    return inspector.inspect(repository.resolveSource(input, sourceId));
  });
  app.post('/api/settings/sources', async (request, reply) => {
    const user = await auth.requireAdmin(request);
    const input = sourceSchema.parse(request.body);
    if (input.useSavedCredential)
      throw new HttpError(400, 'sources.noSavedConnectionStringIsAvailable');
    const { resolved, inspection } = await inspectSource(input);
    return reply
      .code(201)
      .send({ source: repository.saveSource(input, resolved, inspection, user.id) });
  });
  app.put('/api/settings/sources/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const input = sourceSchema.parse(request.body);
    const { resolved, inspection } = await inspectSource(input, id);
    return { source: repository.saveSource(input, resolved, inspection, user.id, id) };
  });
  app.patch('/api/settings/sources/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return { source: repository.setSourceEnabled(id, enabled, user.id) };
  });
  app.delete('/api/settings/sources/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const { confirmation } = z
      .object({ confirmation: z.string().min(1).max(128) })
      .strict()
      .parse(request.body);
    const source = repository.getSources().find((item) => item.id === id);
    if (!source) throw new HttpError(404, 'sources.sourceNotFound');
    if (confirmation.trim().toLowerCase() !== source.accountName.toLowerCase())
      throw new HttpError(400, 'sources.confirmationMismatch');
    repository.deleteSource(id, user.id);
    return { deleted: true };
  });
  app.get('/api/settings/prices', async (request) => {
    await auth.requireAdmin(request);
    return { prices: repository.listPrices() };
  });
  app.post('/api/settings/prices', async (request, reply) => {
    const user = await auth.requireAdmin(request);
    const price = database.connection
      .transaction(() => {
        const price = repository.addPrice(priceSchema.parse(request.body), user.id);
        pricing?.invalidateManual(price.model, price.validFrom, null);
        return price;
      })
      .immediate();
    return reply.code(201).send({ price });
  });
  app.patch('/api/settings/prices/:id', async (request) => {
    const user = await auth.requireAdmin(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const price = database.connection
      .transaction(() => {
        const previous = repository.listPrices().find((price) => price.id === id);
        const price = repository.correctPrice(
          id,
          priceCorrectionSchema.parse(request.body),
          user.id,
        );
        const { from, to } = changedPeriod(previous, price);
        pricing?.invalidateManual(price.model, from, to);
        return price;
      })
      .immediate();
    return { price };
  });
}
