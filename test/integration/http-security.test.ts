import { setTimeout as sleep } from 'node:timers/promises';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/shared/db/pool.js';
import { ALLOWED_ORIGIN, HEALTH_TOKEN, testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('HTTP security middleware', () => {
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

  async function start(overrides: Record<string, string> = {}): Promise<FastifyInstance> {
    app = await buildApp({ config: testConfig(overrides), pool });
    app.post('/test/echo', { config: { public: true } }, (request) => ({ received: request.body }));
    app.get('/test/slow', { config: { public: true } }, async () => {
      await sleep(200);
      return { done: true };
    });
    await app.ready();
    return app;
  }

  const health = { 'x-health-token': HEALTH_TOKEN };

  describe('secure headers', () => {
    it.each([
      ['a successful response', '/health'],
      ['an error response', '/does-not-exist'],
    ])('are set on %s', async (_label, url) => {
      await start();
      const response = await app.inject({ method: 'GET', url, headers: health });

      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none';frame-ancestors 'none'",
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['strict-transport-security']).toContain('max-age=');
      expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('allows the configured origin, including preflight', async () => {
      await start();

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(preflight.headers['access-control-allow-headers']).toContain('DPoP');

      const simple = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { ...health, origin: ALLOWED_ORIGIN },
      });
      expect(simple.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
      expect(simple.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('grants nothing to other origins', async () => {
      await start();
      const evil = 'https://evil.example.com';

      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/health',
        headers: { origin: evil, 'access-control-request-method': 'GET' },
      });
      const simple = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { ...health, origin: evil },
      });

      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect(simple.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('request bodies', () => {
    it('accepts JSON within the size limit', async () => {
      await start();
      const response = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        payload: JSON.stringify({ hello: 'world' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: { hello: 'world' } });
    });

    it('rejects a body over 16 KB with 413', async () => {
      await start();
      const response = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ data: 'x'.repeat(16 * 1024) }),
      });

      expect(response.statusCode).toBe(413);
      expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    });

    it.each([
      'text/plain',
      'application/x-www-form-urlencoded',
      'application/xml',
      'application/jsonx',
      undefined,
    ])('rejects a body with content type %s with 415', async (contentType) => {
      await start();
      const response = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: contentType === undefined ? {} : { 'content-type': contentType },
        payload: '{"a":1}',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    });

    it('rejects malformed JSON with 400 without echoing the input', async () => {
      await start();
      const response = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"secret": "abc",',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
      });
      expect(response.body).not.toContain('secret');
    });
  });

  it('answers a structured 503 when a request exceeds the timeout', async () => {
    await start({ REQUEST_TIMEOUT_MS: '50' });
    const response = await app.inject({ method: 'GET', url: '/test/slow' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: 'REQUEST_TIMEOUT', message: 'The request took too long to complete' },
      requestId: response.headers['x-request-id'],
    });
  });

  it('answers a structured 404 for unknown routes', async () => {
    await start();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
      requestId: response.headers['x-request-id'],
    });
  });

  describe('request IDs', () => {
    it('propagates a well-formed X-Request-Id', async () => {
      await start();
      const response = await app.inject({
        method: 'GET',
        url: '/nope',
        headers: { 'x-request-id': 'client-req-12345' },
      });

      expect(response.headers['x-request-id']).toBe('client-req-12345');
      expect(response.json()).toMatchObject({ requestId: 'client-req-12345' });
    });

    it.each([
      ['absent', undefined],
      ['too short', 'abc'],
      ['unsafe characters', '<script>alert(1)</script>'],
      ['too long', 'a'.repeat(129)],
    ])('generates a UUID when the header is %s', async (_label, value) => {
      await start();
      const response = await app.inject({
        method: 'GET',
        url: '/nope',
        headers: value === undefined ? {} : { 'x-request-id': value },
      });

      expect(response.headers['x-request-id']).toMatch(UUID_PATTERN);
      expect(response.json()).toMatchObject({ requestId: response.headers['x-request-id'] });
    });
  });

  describe('per-IP rate limiting', () => {
    it('answers 429 once an IP exceeds its limit, without affecting other IPs', async () => {
      await start({ RATE_LIMIT_IP_MAX: '3' });
      const fromIp = (remoteAddress: string, url = '/health') =>
        app.inject({ method: 'GET', url, headers: health, remoteAddress });

      for (let i = 0; i < 3; i++) {
        expect((await fromIp('10.0.0.1')).statusCode).toBe(200);
      }
      const limited = await fromIp('10.0.0.1');

      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.json()).toMatchObject({
        error: { code: 'RATE_LIMITED', details: { retryAfterSeconds: 60 } },
      });
      // Unknown routes count too, so scanners cannot probe without limit.
      expect((await fromIp('10.0.0.1', '/nope')).statusCode).toBe(429);
      expect((await fromIp('10.0.0.2')).statusCode).toBe(200);
    });
  });
});
