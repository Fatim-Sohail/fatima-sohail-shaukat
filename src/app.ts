import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { Pool } from 'pg';

import type { Config } from './shared/config.js';
import { registerErrorHandling } from './shared/http/errorHandler.js';
import { registerHealthRoute } from './shared/http/healthRoute.js';
import {
  LOG_REDACT_PATHS,
  registerRequestLogging,
  requestIdFor,
} from './shared/http/requestLogging.js';
import { registerSecurity } from './shared/http/security.js';

export interface AppDependencies {
  config: Config;
  pool: Pool;
  /** Log destination; defaults to stdout. Lets tests inspect structured log output. */
  logStream?: { write(line: string): void };
}

/** Builds a fully wired application without listening, for both the server and tests. */
export async function buildApp({
  config,
  pool,
  logStream,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      ...(logStream ? { stream: logStream } : {}),
    },
    genReqId: requestIdFor,
    requestIdHeader: false,
    // Fastify's built-in per-request lines are replaced by one structured line (requestLogging).
    logController: new LogController({
      requestIdLogLabel: 'requestId',
      disableRequestLogging: true,
    }),
    bodyLimit: config.REQUEST_BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    trustProxy: config.TRUST_PROXY,
  });

  // Order matters: the request ID header is set first so every response carries it,
  // including those rejected by the security hooks.
  registerRequestLogging(app);
  await registerSecurity(app, config);
  registerErrorHandling(app);

  registerHealthRoute(app, { pool, healthCheckToken: config.HEALTH_CHECK_TOKEN });

  return app;
}
