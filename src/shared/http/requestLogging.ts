import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { FastifyInstance } from 'fastify';

/** Restricted charset and length so client-supplied IDs cannot inject into logs. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Credentials that must never reach log output, wherever headers are logged. */
export const LOG_REDACT_PATHS = ['authorization', 'dpop', 'cookie', '["x-health-token"]'].flatMap(
  (header) => [`req.headers.${header}`, `headers.${header}`],
);

/** Reuses a well-formed X-Request-Id from the caller, otherwise generates a fresh one. */
export function requestIdFor(raw: IncomingMessage): string {
  const header = raw.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID();
}

export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
        userId: request.principal?.userId ?? null,
      },
      'request completed',
    );
  });
}
