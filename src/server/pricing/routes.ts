import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import type { PricingService } from './service.js';
import { HttpError } from '../http/errors.js';
import { priceSchema } from '../settings/validation.js';

const modelInput = z
  .object({ displayName: z.string().trim().min(1).max(120), price: priceSchema })
  .strict();

export function registerPricingRoutes(
  app: FastifyInstance,
  auth: AuthService,
  pricing: PricingService,
) {
  app.get('/api/pricing', async (request) => {
    await auth.requireAdmin(request);
    return pricing.state();
  });
  app.post('/api/pricing/models', async (request, reply) => {
    const user = await auth.requireAdmin(request);
    const price = pricing.saveModel(modelInput.parse(request.body), user.id);
    return reply.code(201).send({ price });
  });
  app.put('/api/pricing/models', async (request) => {
    const user = await auth.requireAdmin(request);
    const input = modelInput
      .extend({
        originalModel: z.string().trim().min(1).max(160),
        priceId: z.string().uuid().optional(),
      })
      .parse(request.body);
    return { price: pricing.saveModel(input, user.id) };
  });
  app.post('/api/pricing/prefill', async (request) => {
    await auth.requireAdmin(request);
    const { model } = z
      .object({
        model: z.string().trim().min(1).max(160),
      })
      .strict()
      .parse(request.body);
    return { options: await pricing.prefill(model) };
  });
  app.post('/api/pricing/models/refresh', async (request) => {
    const user = await auth.requireAdmin(request);
    z.object({}).strict().parse(request.body);
    return pricing.refreshModels(user.id);
  });
  app.delete('/api/pricing/models', async (request) => {
    const user = await auth.requireAdmin(request);
    const { model, confirmation } = z
      .object({
        model: z.string().trim().min(1).max(160),
        confirmation: z.string().trim().min(1).max(160),
      })
      .strict()
      .parse(request.body);
    if (model.toLowerCase() !== confirmation.toLowerCase())
      throw new HttpError(400, 'pricing.modelConfirmationMismatch');
    return { deleted: pricing.deleteModelPrices(model, user.id) };
  });
}
