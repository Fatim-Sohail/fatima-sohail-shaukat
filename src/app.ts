import Fastify, { type FastifyInstance, LogController } from 'fastify';
import type { Pool } from 'pg';

import { createAccessTokenVerifier } from './shared/auth/accessToken.js';
import { createDpopVerifier } from './shared/auth/dpop.js';
import type { Config } from './shared/config.js';
import { registerAuthentication } from './shared/http/auth.js';
import { registerAuthRoutes } from './shared/http/authRoutes.js';
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
    // No implicit HEAD copy of every GET route: less surface, and nothing a JSON API needs.
    exposeHeadRoutes: false,
  });

  // Order matters: the request ID header is set first so every response carries it,
  // including those rejected by the security hooks.
  registerRequestLogging(app);
  await registerSecurity(app, config);
  registerErrorHandling(app);

  // Must come before any route: it makes every later route authenticated by default.
  registerAuthentication(app, {
    config,
    pool,
    verifyToken: createAccessTokenVerifier(config),
    verifyDpop: createDpopVerifier({ pool, proofMaxAgeSeconds: config.DPOP_PROOF_MAX_AGE_SECONDS }),
  });

  registerHealthRoute(app, { pool, healthCheckToken: config.HEALTH_CHECK_TOKEN });
  registerAuthRoutes(app);

  return app;
}
