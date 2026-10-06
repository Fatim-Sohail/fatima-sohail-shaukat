import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/shared/db/pool.js';
import { AppError } from '../../src/shared/errors.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

describe('centralized error handling and logging', () => {
  let pool: Pool;
  let app: FastifyInstance;
  const logLines: string[] = [];

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    app = await buildApp({
      config: testConfig({ LOG_LEVEL: 'info' }),
      pool,
      logStream: { write: (line) => void logLines.push(line) },
    });

    app.get('/test/app-error', { config: { public: true } }, () => {
      throw new AppError('not_found', 'WIDGET_NOT_FOUND', 'Widget not found', { widgetId: 'w1' });
    });
    app.post('/test/validated', { config: { public: true } }, (request) => {
      return z.strictObject({ name: z.string().min(1) }).parse(request.body);
    });
    app.get('/test/crash', { config: { public: true } }, () => {
      throw new Error('connection to db-internal.local failed: password=hunter2');
    });
    app.get('/test/log-headers', { config: { public: true } }, (request) => {
      request.log.info({ headers: request.headers }, 'headers seen');
      return { ok: true };
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const logs = (): Record<string, unknown>[] =>
    logLines.map((line) => JSON.parse(line) as Record<string, unknown>);

  it('maps an AppError to its status, code, message and details', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/app-error' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'WIDGET_NOT_FOUND', message: 'Widget not found', details: { widgetId: 'w1' } },
      requestId: response.headers['x-request-id'],
    });
  });

  it('maps schema validation failures to 400 VALIDATION_FAILED with issue paths', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validated',
      payload: { name: '', role: 'admin' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json<{
      error: { code: string; details: { issues: { path: string }[] } };
    }>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['name', '']),
    );
  });

  it('hides unexpected errors behind a generic 500 and logs them server-side', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/crash' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      requestId: response.headers['x-request-id'],
    });
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('stack');

    const failure = logs().find((entry) => entry['msg'] === 'request failed');
    expect(failure).toMatchObject({ level: 50, requestId: response.headers['x-request-id'] });
  });

  it('logs one structured line per request with request ID, response time and user ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/app-error',
      headers: { 'x-request-id': 'trace-abc-123' },
    });

    const completed = logs().find(
      (entry) => entry['msg'] === 'request completed' && entry['requestId'] === 'trace-abc-123',
    );
    expect(response.statusCode).toBe(404);
    expect(completed).toMatchObject({
      method: 'GET',
      url: '/test/app-error',
      statusCode: 404,
      userId: null,
    });
    expect(completed?.['responseTimeMs']).toEqual(expect.any(Number));
  });

  it('redacts credentials if headers are ever logged', async () => {
    await app.inject({
      method: 'GET',
      url: '/test/log-headers',
      headers: {
        authorization: 'Bearer secret-access-token',
        dpop: 'secret-dpop-proof',
        'x-health-token': 'secret-health-token',
      },
    });

    const output = logLines.join('\n');
    expect(output).not.toContain('secret-access-token');
    expect(output).not.toContain('secret-dpop-proof');
    expect(output).not.toContain('secret-health-token');
    expect(logs().find((entry) => entry['msg'] === 'headers seen')).toMatchObject({
      headers: { authorization: '[REDACTED]', dpop: '[REDACTED]' },
    });
  });
});
