import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { errorBody } from './errorHandler.js';

/**
 * Answers 503 once a request exceeds the time budget. The handler is not
 * cancelled; long-running work must also honour its own timeouts.
 */
function registerRequestTimeout(app: FastifyInstance, timeoutMs: number): void {
  const timers = new WeakMap<FastifyRequest, NodeJS.Timeout>();

  app.addHook('onRequest', async (request, reply) => {
    const timer = setTimeout(() => {
      if (reply.sent) {
        return;
      }
      request.log.warn({ timeoutMs }, 'request timed out');
      void reply
        .status(503)
        .send(errorBody(request, 'REQUEST_TIMEOUT', 'The request took too long to complete'));
    }, timeoutMs);
    timers.set(request, timer);
  });
  app.addHook('onResponse', (request, _reply, done) => {
    clearTimeout(timers.get(request));
    done();
  });
  app.addHook('onRequestAbort', (request, done) => {
    clearTimeout(timers.get(request));
    done();
  });
}

export async function registerSecurity(app: FastifyInstance, config: Config): Promise<void> {
  registerRequestTimeout(app, config.REQUEST_TIMEOUT_MS);

  // JSON-only API: no scripts, frames or other resources are ever served.
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });

  await app.register(cors, {
    origin: [...config.CORS_ALLOWED_ORIGINS],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'DPoP', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: false,
    maxAge: 600,
  });

  // Per-IP limit for every route, including unknown ones. In-memory store: one instance only.
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_IP_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_request, context) =>
      new AppError('rate_limited', 'RATE_LIMITED', 'Too many requests, retry later', {
        retryAfterSeconds: Math.ceil(context.ttl / 1000),
      }),
  });

  // The global limit only attaches to registered routes; unknown routes need it explicitly
  // so scanners cannot probe without limit. Thrown so the 404 uses the central error shape.
  app.setNotFoundHandler({ preHandler: app.rateLimit() }, () => {
    throw new AppError('not_found', 'NOT_FOUND', 'Resource not found');
  });

  // Only JSON bodies are accepted; Fastify answers 415 for any other content type.
  app.removeContentTypeParser('text/plain');

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });
}
