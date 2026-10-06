import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { AppError } from '../errors.js';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** Health probe protected by a static token (X-Health-Token) and backed by a DB round trip. */
export function registerHealthRoute(
  app: FastifyInstance,
  deps: { pool: Pool; healthCheckToken: string },
): void {
  // Comparing fixed-length digests keeps the check constant-time regardless of input length.
  const expectedDigest = sha256(deps.healthCheckToken);

  app.get('/health', async (request) => {
    const provided = request.headers['x-health-token'];
    if (typeof provided !== 'string' || !timingSafeEqual(sha256(provided), expectedDigest)) {
      throw new AppError('unauthenticated', 'UNAUTHORIZED', 'Missing or invalid health token');
    }

    try {
      await deps.pool.query('SELECT 1');
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      throw new AppError('unavailable', 'SERVICE_UNAVAILABLE', 'Database is unreachable');
    }

    return { status: 'ok', checks: { database: 'ok' } };
  });
}
