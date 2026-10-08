import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Message, MessageKey } from '../../shared/i18n/translate.js';
import type { ApiErrorBody } from '../../shared/api-error.js';
import { validationMessage } from './validation-message.js';
export class HttpError extends Error {
  readonly body: ApiErrorBody;
  constructor(
    public statusCode: number,
    value: MessageKey | Message,
  ) {
    const descriptor = typeof value === 'string' ? { key: value } : value;
    super(descriptor.key);
    this.body = {
      code: descriptor.key,
      ...(descriptor.params ? { params: descriptor.params } : {}),
    };
  }
}
export function registerErrors(app: FastifyInstance) {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        code: 'errors.invalidValue',
        issues: error.issues.map((issue) => ({
          ...validationMessage(issue),
          ...(issue.path.length ? { path: issue.path.join('.') } : {}),
        })),
      } satisfies ApiErrorBody);
    if (error instanceof HttpError) return reply.code(error.statusCode).send(error.body);
    const code = (error as { code?: string }).code;
    if (code?.startsWith('SQLITE_CONSTRAINT'))
      return reply.code(409).send({ code: 'errors.recordConflict' });
    if ((error as { statusCode?: number }).statusCode === 400)
      return reply.code(400).send({ code: 'errors.invalidRequest' });
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Request failed',
    );
    return reply.code(500).send({ code: 'errors.operationIncomplete' });
  });
}
