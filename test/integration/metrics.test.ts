import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { createMockAiProvider } from '../../src/modules/chat/infrastructure/mockAiProvider.js';
import { createMockPaymentGateway } from '../../src/modules/subscriptions/infrastructure/mockPaymentGateway.js';
import { createPool } from '../../src/shared/db/pool.js';
import { startMockIdp, type MockIdp } from '../helpers/mockIdp.js';
import { BASE_URL, call, login, type Session } from '../helpers/session.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

interface Metrics {
  month: string;
  users: { total: number };
  chats: { thisMonth: number };
  subscriptions: {
    active: { basic: number; pro: number; enterprise: number; total: number };
  };
  payments: { succeeded: number; failed: number };
}

describe('GET /metrics', () => {
  let idp: MockIdp;
  let pool: Pool;
  let app: FastifyInstance;
  let clock: Date;
  let decline: boolean;
  let admin: Session;

  beforeAll(async () => {
    idp = await startMockIdp();
    pool = createPool(TEST_DATABASE_URL);
  });
  beforeEach(async () => {
    clock = NOW;
    decline = false;
    app = await buildApp({
      config: testConfig({
        OIDC_ISSUER: idp.issuer,
        OIDC_AUDIENCE: idp.audience,
        OIDC_JWKS_URI: idp.jwksUri,
        PUBLIC_BASE_URL: BASE_URL,
      }),
      pool,
      now: () => clock,
      ai: createMockAiProvider({ latencyMs: 0 }),
      payments: createMockPaymentGateway({ failureRate: 0.5, random: () => (decline ? 0 : 1) }),
    });
    await app.ready();
    admin = await login(idp, 'root', ['user', 'admin']);
  });
  afterEach(async () => {
    await app.close();
    await pool.query(
      'TRUNCATE users, subscriptions, payments, chat_messages, monthly_usage, dpop_replay, token_bindings CASCADE',
    );
  });
  afterAll(async () => {
    await idp.close();
    await pool.end();
  });

  async function metrics(): Promise<Metrics> {
    const response = await call(app, admin, 'GET', '/metrics');
    expect(response.statusCode).toBe(200);
    return response.json<Metrics>();
  }

  async function insertUser(subject: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (idp_issuer, idp_subject) VALUES ('https://idp.test', $1) RETURNING id`,
      [subject],
    );
    return rows[0]!.id;
  }

  async function insertSubscription(
    userId: string,
    tier: 'basic' | 'pro' | 'enterprise',
    options: { status?: string; end?: Date } = {},
  ): Promise<string> {
    const maxMessages = { basic: 10, pro: 100, enterprise: null }[tier];
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, tier, billing_cycle, max_messages, price_cents,
         auto_renew, status, start_date, end_date)
       VALUES ($1, $2, 'monthly', $3, 999, false, $4, $5, $6) RETURNING id`,
      [userId, tier, maxMessages, options.status ?? 'active', days(-40), options.end ?? days(20)],
    );
    return rows[0]!.id;
  }

  async function insertPayment(subscriptionId: string, status: 'succeeded' | 'failed') {
    await pool.query(
      `INSERT INTO payments (subscription_id, amount_cents, status, period_start, period_end)
       VALUES ($1, 999, $2, $3, $4)`,
      [subscriptionId, status, days(-10), days(20)],
    );
  }

  async function insertChat(userId: string, createdAt: string) {
    await pool.query(
      `INSERT INTO chat_messages (user_id, question, answer, model, prompt_tokens,
         completion_tokens, total_tokens, quota_source, request_id, created_at)
       VALUES ($1, 'q', 'a', 'mock', 1, 1, 2, 'free', 'req', $2)`,
      [userId, createdAt],
    );
  }

  it('is admin-only', async () => {
    const asUser = await call(app, await login(idp, 'alice'), 'GET', '/metrics');
    const anonymous = await app.inject({ method: 'GET', url: '/metrics' });

    expect(asUser.statusCode).toBe(403);
    expect(asUser.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(anonymous.statusCode).toBe(401);
  });

  it('reports zeros, with every tier present, on an empty system', async () => {
    expect(await metrics()).toEqual({
      generatedAt: NOW.toISOString(),
      month: '2026-10',
      users: { total: 1 },
      chats: { thisMonth: 0 },
      subscriptions: { active: { basic: 0, pro: 0, enterprise: 0, total: 0 } },
      payments: { succeeded: 0, failed: 0 },
    });
  });

  it('counts users, active subscriptions by tier and payments', async () => {
    const alice = await insertUser('alice');
    const bob = await insertUser('bob');
    const basic = await insertSubscription(alice, 'basic');
    const pro = await insertSubscription(alice, 'pro');
    await insertSubscription(bob, 'pro');
    await insertSubscription(bob, 'enterprise');
    await insertSubscription(bob, 'basic', { status: 'inactive' });
    await insertSubscription(bob, 'pro', { end: days(-1) });
    await insertPayment(basic, 'succeeded');
    await insertPayment(pro, 'succeeded');
    await insertPayment(pro, 'succeeded');
    await insertPayment(basic, 'failed');

    expect(await metrics()).toMatchObject({
      users: { total: 3 },
      subscriptions: { active: { basic: 1, pro: 2, enterprise: 1, total: 4 } },
      payments: { succeeded: 3, failed: 1 },
    });
  });

  it('counts only chats from the current UTC month', async () => {
    const alice = await insertUser('alice');
    await insertChat(alice, '2026-09-30T23:59:59.999Z');
    await insertChat(alice, '2026-10-01T00:00:00.000Z');
    await insertChat(alice, '2026-10-15T08:00:00.000Z');
    await insertChat(alice, '2026-10-31T23:59:59.999Z');
    await insertChat(alice, '2026-11-01T00:00:00.000Z');

    expect((await metrics()).chats).toEqual({ thisMonth: 3 });

    clock = new Date('2026-11-20T00:00:00.000Z');
    expect(await metrics()).toMatchObject({ month: '2026-11', chats: { thisMonth: 1 } });
  });

  it('moves with the API: subscriptions, declined payments and chats', async () => {
    const before = await metrics();
    const alice = await login(idp, 'alice');

    expect(
      (
        await call(app, alice, 'POST', '/subscriptions', {
          tier: 'pro',
          billingCycle: 'monthly',
          autoRenew: true,
        })
      ).statusCode,
    ).toBe(201);
    decline = true;
    expect(
      (
        await call(app, alice, 'POST', '/subscriptions', {
          tier: 'basic',
          billingCycle: 'monthly',
          autoRenew: true,
        })
      ).statusCode,
    ).toBe(402);
    expect((await call(app, alice, 'POST', '/chat/messages', { question: 'Hi' })).statusCode).toBe(
      201,
    );

    const after = await metrics();
    expect(after.users.total).toBe(before.users.total + 1);
    expect(after.subscriptions.active).toEqual({ basic: 0, pro: 1, enterprise: 0, total: 1 });
    expect(after.payments).toEqual({ succeeded: 1, failed: 1 });
    expect(after.chats.thisMonth).toBe(before.chats.thisMonth + 1);
  });

  it('rejects query parameters', async () => {
    expect((await call(app, admin, 'GET', '/metrics?month=2026-09')).statusCode).toBe(400);
  });
});
