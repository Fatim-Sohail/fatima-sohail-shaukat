import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/shared/db/pool.js';
import { HEALTH_TOKEN, testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

describe('GET /health', () => {
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-health-token': 'x'.repeat(HEALTH_TOKEN.length) }],
    ['a prefix of the real one', { 'x-health-token': HEALTH_TOKEN.slice(0, -1) }],
  ])('answers 401 when the token is %s', async (_label, headers) => {
    app = await buildApp({ config: testConfig(), pool });
    const response = await app.inject({ method: 'GET', url: '/health', headers });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('answers 200 after a database round trip when the token is valid', async () => {
    app = await buildApp({ config: testConfig(), pool });
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-health-token': HEALTH_TOKEN },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('answers a structured 503 when the database is unreachable', async () => {
    const deadPool = new Pool({
      connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none',
      connectionTimeoutMillis: 500,
    });
    app = await buildApp({ config: testConfig(), pool: deadPool });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-health-token': HEALTH_TOKEN },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Database is unreachable' },
      });
    } finally {
      await deadPool.end();
    }
  });
});
