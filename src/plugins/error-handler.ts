import type { FastifyError, FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const requestId = req.id;

    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.validation.map((v) => ({
            path: `${err.validationContext ?? 'body'}${v.instancePath.replaceAll('/', '.')}`,
            message: v.message,
          })),
          requestId,
        },
      });
    }

    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, err.message);
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details, requestId },
      });
    }

    if (isResponseSerializationError(err)) {
      req.log.error({ err, cause: err.cause }, 'response serialization failed');
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } });
    }

    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply
        .status(500)
        .send({ error: { code: 'INTERNAL', message: 'Internal server error', requestId } });
    }

    // Framework errors: malformed JSON, payload too large, rate limiting, etc.
    const code = status === 429 ? 'RATE_LIMITED' : (err.code ?? 'BAD_REQUEST');
    return reply.status(status).send({ error: { code, message: err.message, requestId } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, requestId: req.id },
    }),
  );
}
