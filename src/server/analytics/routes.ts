import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service.js';
import { filterSchema } from './query.js';
import type { createAnalyticsService } from './service.js';

export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  auth: AuthService,
  analytics: ReturnType<typeof createAnalyticsService>,
) {
  app.get('/api/analytics/facets', async (request) => {
    await auth.requireUser(request);
    return analytics.facets(true);
  });
  app.get('/api/analytics', async (request) => {
    await auth.requireUser(request);
    return analytics.report({
      ...filterSchema.parse(request.query),
      pricedModels: analytics.pricedModels(),
    });
  });
  app.get('/api/requests/detail', async (request) => {
    await auth.requireUser(request);
    const { resourceId, correlationId } = z
      .object({ resourceId: z.string().max(2048), correlationId: z.string().max(512) })
      .parse(request.query);
    return {
      request:
        analytics.requests({ resourceId, requestId: correlationId, includeNonModel: true }, 1)
          .requests[0] ?? null,
    };
  });
  app.get('/api/requests', async (request) => {
    await auth.requireUser(request);
    const filters = {
      ...filterSchema.parse(request.query),
      pricedModels: analytics.pricedModels(),
    };
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).max(10000000).default(0),
      })
      .parse(request.query);
    return analytics.requests(filters, limit, offset);
  });
  app.get('/api/requests/export.csv', async (request, reply) => {
    await auth.requireUser(request);
    const { requests, total } = analytics.requests(
      { ...filterSchema.parse(request.query), pricedModels: analytics.pricedModels() },
      100000,
    );
    const rows: unknown[][] = [
      [
        'time',
        'time_source',
        'resource_id',
        'correlation_id',
        'model',
        'model_version',
        'deployment',
        'caller_ip',
        'status',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'duration_ms',
        'cost_usd',
      ],
    ];
    for (const row of requests)
      rows.push([
        row.time,
        row.timeSource ?? 'event',
        row.resourceId,
        row.correlationId,
        row.model,
        row.modelVersion,
        row.deployment,
        row.callerIp,
        row.statusCode,
        row.inputTokens,
        row.outputTokens,
        row.cachedTokens,
        row.cacheWriteTokens,
        row.durationMs,
        row.cost?.knownUsd,
      ]);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="foundry-requests.csv"')
      .header('X-FTL-Export-Truncated', total > 100000 ? 'true' : 'false')
      .send('\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'));
  });
}
