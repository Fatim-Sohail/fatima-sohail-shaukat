import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../../src/app.js';
import { assertAdmin, assertCanAccess } from '../../src/shared/auth/policy.js';
import { createPool } from '../../src/shared/db/pool.js';
import { AppError } from '../../src/shared/errors.js';
import { principalOf, requireRole } from '../../src/shared/http/auth.js';
import { createDpopKey, createDpopProof, type DpopKey } from '../helpers/dpopClient.js';
import { startMockIdp, type MintOptions, type MockIdp } from '../helpers/mockIdp.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const BASE_URL = 'https://api.example.com';

interface Session {
  key: DpopKey;
  token: string;
}

interface Me {
  userId: string;
  issuer: string;
  subject: string;
  roles: string[];
}

describe('authenticated API', () => {
  let idp: MockIdp;
  let pool: Pool;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    idp = await startMockIdp();
    pool = createPool(TEST_DATABASE_URL);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await pool.query('TRUNCATE users, dpop_replay, token_bindings CASCADE');
  });
  afterAll(async () => {
    await idp.close();
    await pool.end();
  });

  async function start(
    options: {
      env?: Record<string, string>;
      provider?: MockIdp;
      routes?: (app: FastifyInstance) => void;
    } = {},
  ): Promise<FastifyInstance> {
    const provider = options.provider ?? idp;
    const app = await buildApp({
      config: testConfig({
        OIDC_ISSUER: provider.issuer,
        OIDC_AUDIENCE: provider.audience,
        OIDC_JWKS_URI: provider.jwksUri,
        PUBLIC_BASE_URL: BASE_URL,
        ...options.env,
      }),
      pool,
    });
    options.routes?.(app);
    await app.ready();
    apps.push(app);
    return app;
  }

  async function login(
    subject: string,
    roles: string[] = ['user'],
    extra: { provider?: MockIdp; token?: MintOptions } = {},
  ): Promise<Session> {
    const token = await (extra.provider ?? idp).mintToken({
      subject,
      claims: { roles },
      ...extra.token,
    });
    return { key: await createDpopKey(), token };
  }

  /** Sends a request the way a real client would: DPoP token plus a fresh proof. */
  async function call(
    app: FastifyInstance,
    session: Session,
    url: string,
    options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; proofUrl?: string } = {},
  ) {
    const method = options.method ?? 'GET';
    const proof = await createDpopProof(session.key, {
      method,
      url: options.proofUrl ?? `${BASE_URL}${url}`,
      accessToken: session.token,
    });
    return app.inject({
      method,
      url,
      headers: { authorization: `DPoP ${session.token}`, dpop: proof, ...options.headers },
    });
  }

  async function me(app: FastifyInstance, session: Session): Promise<Me> {
    const response = await call(app, session, '/auth/me');
    expect(response.statusCode).toBe(200);
    return response.json<Me>();
  }

  async function userCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM users');
    return Number(rows[0]!.count);
  }

  describe('authentication', () => {
    it('rejects a protected route without credentials', async () => {
      const app = await start();
      const response = await app.inject({ method: 'GET', url: '/auth/me' });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'MISSING_TOKEN' } });
    });

    it('accepts a valid OIDC token with a valid DPoP proof', async () => {
      const app = await start();
      const response = await call(app, await login('alice'), '/auth/me');

      expect(response.statusCode).toBe(200);
    });

    it('rejects an invalid token without revealing why', async () => {
      const app = await start();
      const response = await call(
        app,
        await login('alice', ['user'], { token: { expiresIn: -60 } }),
        '/auth/me',
      );

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_TOKEN', message: 'Access token is invalid or expired' },
      });
      expect(response.body).not.toMatch(/ERR_|JWT/);
    });

    it('rejects a valid token presented without a DPoP proof', async () => {
      const app = await start();
      const { token } = await login('alice');

      const asDpop = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `DPoP ${token}` },
      });
      const asBearer = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(asDpop.statusCode).toBe(401);
      expect(asDpop.json()).toMatchObject({ error: { code: 'INVALID_DPOP_PROOF' } });
      expect(asBearer.statusCode).toBe(401);
      expect(asBearer.json()).toMatchObject({ error: { code: 'MISSING_TOKEN' } });
    });

    it('rejects a valid token with an invalid DPoP proof', async () => {
      const app = await start();
      const response = await call(app, await login('alice'), '/auth/me', {
        proofUrl: `${BASE_URL}/somewhere-else`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'INVALID_DPOP_PROOF', message: 'DPoP proof is missing or invalid' },
        requestId: response.headers['x-request-id'],
      });
    });

    it('rejects a replayed DPoP proof', async () => {
      const app = await start();
      const session = await login('alice');
      const proof = await createDpopProof(session.key, {
        method: 'GET',
        url: `${BASE_URL}/auth/me`,
        accessToken: session.token,
      });
      const send = () =>
        app.inject({
          method: 'GET',
          url: '/auth/me',
          headers: { authorization: `DPoP ${session.token}`, dpop: proof },
        });

      expect((await send()).statusCode).toBe(200);
      const replay = await send();
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ error: { code: 'DPOP_REPLAY' } });
    });

    it('rejects a stolen token used with another key', async () => {
      const app = await start();
      const victim = await login('alice');
      await me(app, victim);

      const response = await call(
        app,
        { key: await createDpopKey(), token: victim.token },
        '/auth/me',
      );
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'DPOP_KEY_MISMATCH' } });
    });

    it('checks htu against PUBLIC_BASE_URL, ignoring client-controlled Host headers', async () => {
      const app = await start();
      const session = await login('alice');
      const spoofed = {
        host: 'evil.example.com',
        'x-forwarded-host': 'evil.example.com',
        'x-forwarded-proto': 'http',
      };

      const honest = await call(app, session, '/auth/me', { headers: spoofed });
      const followsHost = await call(app, session, '/auth/me', {
        headers: spoofed,
        proofUrl: 'http://evil.example.com/auth/me',
      });

      expect(honest.statusCode).toBe(200);
      expect(followsHost.statusCode).toBe(401);
    });

    it('protects every non-public route by default, and requires a rate-limit group', async () => {
      const app = await buildApp({ config: testConfig(), pool });
      apps.push(app);

      expect(() => app.get('/test/forgot-group', () => ({}))).toThrow(/rateLimitGroup/);
      app.get('/test/new-route', { config: { rateLimitGroup: 'chat' } }, () => ({ leaked: true }));
      const response = await app.inject({ method: 'GET', url: '/test/new-route' });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('user provisioning', () => {
    it('creates a local user on first login, keyed by issuer and subject', async () => {
      const app = await start();
      const { userId } = await me(app, await login('alice'));

      const { rows } = await pool.query('SELECT id, idp_issuer, idp_subject FROM users');
      expect(rows).toEqual([{ id: userId, idp_issuer: idp.issuer, idp_subject: 'alice' }]);
    });

    it('reuses the same user on later logins', async () => {
      const app = await start();
      const first = await me(app, await login('alice'));
      const second = await me(app, await login('alice'));

      expect(second.userId).toBe(first.userId);
      expect(await userCount()).toBe(1);
    });

    it('creates a separate user for the same subject from another issuer', async () => {
      const otherIdp = await startMockIdp();
      try {
        const appA = await start();
        const appB = await start({ provider: otherIdp });

        const a = await me(appA, await login('alice'));
        const b = await me(appB, await login('alice', ['user'], { provider: otherIdp }));

        expect(b.userId).not.toBe(a.userId);
        expect(b.issuer).toBe(otherIdp.issuer);
        expect(await userCount()).toBe(2);
      } finally {
        await otherIdp.close();
      }
    });

    it('creates exactly one user when first logins race', async () => {
      const app = await start();
      const session = await login('alice');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => call(app, session, '/auth/me')),
      );

      const ids = new Set(responses.map((response) => response.json<Me>().userId));
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(ids.size).toBe(1);
      expect(await userCount()).toBe(1);
    });
  });

  describe('GET /auth/me', () => {
    it('returns the local user ID with the verified issuer, subject and roles', async () => {
      const app = await start();
      const body = await me(app, await login('alice', ['user', 'admin']));

      expect(body).toEqual({
        userId: expect.any(String) as string,
        issuer: idp.issuer,
        subject: 'alice',
        roles: ['user', 'admin'],
      });
    });

    it('takes identity only from verified authentication, never from request input', async () => {
      const app = await start();
      const bob = await me(app, await login('bob'));
      const alice = await login('alice');

      const withHeaders = await call(app, alice, '/auth/me', {
        headers: { 'x-user-id': bob.userId, 'x-roles': 'admin' },
      });
      const withQuery = await call(app, alice, `/auth/me?userId=${bob.userId}`);

      expect(withHeaders.json()).toMatchObject({ subject: 'alice', roles: ['user'] });
      expect(withHeaders.json<Me>().userId).not.toBe(bob.userId);
      expect(withQuery.statusCode).toBe(400);
      expect(withQuery.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });

  describe('RBAC and ownership', () => {
    // Stand-ins for the admin and user-owned routes that later modules add.
    const routes = (app: FastifyInstance): void => {
      app.get(
        '/test/admin',
        { config: { rateLimitGroup: 'auth' }, preHandler: requireRole('admin') },
        () => ({ ok: true }),
      );
      // No controller guard on purpose: the domain policy alone must stop non-admins.
      app.get('/test/admin-policy-only', { config: { rateLimitGroup: 'auth' } }, (request) => {
        assertAdmin(principalOf(request));
        return { ok: true };
      });
      app.get('/test/users/:id', { config: { rateLimitGroup: 'auth' } }, async (request) => {
        const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
        assertCanAccess(principalOf(request), id);
        const { rows } = await pool.query('SELECT id, idp_subject FROM users WHERE id = $1', [id]);
        if (!rows[0]) {
          throw new AppError('not_found', 'NOT_FOUND', 'Resource not found');
        }
        return rows[0] as unknown;
      });
    };

    it('rejects a normal user on an admin route with 403', async () => {
      const app = await start({ routes });
      const response = await call(app, await login('alice'), '/test/admin');

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    });

    it('allows an admin on an admin route', async () => {
      const app = await start({ routes });
      const response = await call(app, await login('root', ['user', 'admin']), '/test/admin');

      expect(response.statusCode).toBe(200);
    });

    it('enforces admin access in the domain policy even without the controller guard', async () => {
      const app = await start({ routes });

      expect((await call(app, await login('alice'), '/test/admin-policy-only')).statusCode).toBe(
        403,
      );
      expect(
        (await call(app, await login('root', ['admin']), '/test/admin-policy-only')).statusCode,
      ).toBe(200);
    });

    it('lets users read their own resource but answers 404 for anyone else’s', async () => {
      const app = await start({ routes });
      const alice = await login('alice');
      const bob = await login('bob');
      const aliceId = (await me(app, alice)).userId;
      const bobId = (await me(app, bob)).userId;

      const own = await call(app, alice, `/test/users/${aliceId}`);
      const other = await call(app, alice, `/test/users/${bobId}`);
      const missing = await call(app, alice, '/test/users/00000000-0000-4000-8000-000000000000');

      expect(own.statusCode).toBe(200);
      expect(other.statusCode).toBe(404);
      // Indistinguishable from a resource that does not exist.
      expect(other.json<{ error: unknown }>().error).toEqual(
        missing.json<{ error: unknown }>().error,
      );
    });

    it('lets an admin read another user’s resource', async () => {
      const app = await start({ routes });
      const bobId = (await me(app, await login('bob'))).userId;

      const response = await call(app, await login('root', ['admin']), `/test/users/${bobId}`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: bobId, idp_subject: 'bob' });
    });
  });

  describe('per-user rate limiting', () => {
    const groupRoutes = (app: FastifyInstance): void => {
      app.get('/test/chat', { config: { rateLimitGroup: 'chat' } }, () => ({ ok: true }));
      app.get('/test/subscriptions', { config: { rateLimitGroup: 'subscriptions' } }, () => ({
        ok: true,
      }));
    };

    async function statuses(app: FastifyInstance, session: Session, url: string, times: number) {
      const codes: number[] = [];
      for (let i = 0; i < times; i++) {
        codes.push((await call(app, session, url)).statusCode);
      }
      return codes;
    }

    it('applies the per-IP limit before authentication runs', async () => {
      const app = await start({ env: { RATE_LIMIT_IP_MAX: '2' } });
      const anonymous = () => app.inject({ method: 'GET', url: '/auth/me' });

      // If auth ran first, its 401 would stop the chain and the IP limit would never count.
      const codes = [];
      for (let i = 0; i < 3; i++) {
        codes.push((await anonymous()).statusCode);
      }
      expect(codes).toEqual([401, 401, 429]);
    });

    it('limits a user who exceeds their quota without affecting other users', async () => {
      const app = await start({ env: { RATE_LIMIT_AUTH_MAX: '2' } });
      const alice = await login('alice');
      const bob = await login('bob');

      expect(await statuses(app, alice, '/auth/me', 2)).toEqual([200, 200]);
      const limited = await call(app, alice, '/auth/me');

      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect((await call(app, bob, '/auth/me')).statusCode).toBe(200);
    });

    it('applies separate limits and counters per route group', async () => {
      const app = await start({
        env: {
          RATE_LIMIT_AUTH_MAX: '1',
          RATE_LIMIT_CHAT_MAX: '3',
          RATE_LIMIT_SUBSCRIPTION_MAX: '2',
        },
        routes: groupRoutes,
      });
      const alice = await login('alice');

      expect(await statuses(app, alice, '/auth/me', 2)).toEqual([200, 429]);
      expect(await statuses(app, alice, '/test/chat', 4)).toEqual([200, 200, 200, 429]);
      expect(await statuses(app, alice, '/test/subscriptions', 3)).toEqual([200, 200, 429]);
    });
  });
});
