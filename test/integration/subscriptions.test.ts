import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import { addBillingCycle } from '../../src/modules/subscriptions/domain/entities/period.js';
import {
  createMockPaymentGateway,
  type MockPaymentGateway,
} from '../../src/modules/subscriptions/infrastructure/mockPaymentGateway.js';
import { createPool } from '../../src/shared/db/pool.js';
import { startMockIdp, type MockIdp } from '../helpers/mockIdp.js';
import { BASE_URL, call, login, type Session } from '../helpers/session.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

interface Sub {
  id: string;
  userId: string;
  tier: string;
  billingCycle: string;
  maxMessages: number | null;
  messagesUsed: number;
  priceCents: number;
  autoRenew: boolean;
  status: string;
  startDate: string;
  endDate: string;
  renewalDate: string | null;
  cancelledAt: string | null;
}

interface PaymentRow {
  amount_cents: number;
  status: string;
  period_start: Date;
  period_end: Date;
}

const iso = (date: Date): string => date.toISOString();

describe('subscriptions API', () => {
  let idp: MockIdp;
  let pool: Pool;
  let app: FastifyInstance;
  let payments: MockPaymentGateway;
  let clock: Date;
  let decline: boolean;

  beforeAll(async () => {
    idp = await startMockIdp();
    pool = createPool(TEST_DATABASE_URL);
  });
  beforeEach(async () => {
    clock = new Date();
    decline = false;
    app = await startApp();
  });
  afterEach(async () => {
    await app.close();
    await pool.query(
      'TRUNCATE users, subscriptions, payments, dpop_replay, token_bindings CASCADE',
    );
  });
  afterAll(async () => {
    await idp.close();
    await pool.end();
  });

  /** Payments succeed unless `decline` is set; `latencyMs` makes charges overlap in time. */
  async function startApp(latencyMs = 0): Promise<FastifyInstance> {
    payments = createMockPaymentGateway({
      failureRate: 0.5,
      random: () => (decline ? 0 : 1),
      latencyMs,
    });
    const instance = await buildApp({
      config: testConfig({
        OIDC_ISSUER: idp.issuer,
        OIDC_AUDIENCE: idp.audience,
        OIDC_JWKS_URI: idp.jwksUri,
        PUBLIC_BASE_URL: BASE_URL,
      }),
      pool,
      payments,
      now: () => clock,
    });
    await instance.ready();
    return instance;
  }

  const defaults = { tier: 'basic', billingCycle: 'monthly', autoRenew: true };

  async function subscribe(session: Session, body: Record<string, unknown> = {}): Promise<Sub> {
    const response = await call(app, session, 'POST', '/subscriptions', { ...defaults, ...body });
    expect(response.statusCode).toBe(201);
    return response.json<Sub>();
  }

  async function userId(session: Session): Promise<string> {
    return (await call(app, session, 'GET', '/auth/me')).json<{ userId: string }>().userId;
  }

  async function paymentsFor(subscriptionId: string): Promise<PaymentRow[]> {
    const { rows } = await pool.query<PaymentRow>(
      `SELECT amount_cents, status, period_start, period_end FROM payments
       WHERE subscription_id = $1 ORDER BY period_start, created_at`,
      [subscriptionId],
    );
    return rows;
  }

  async function runBilling(admin: Session) {
    const response = await call(app, admin, 'POST', '/admin/billing/run');
    expect(response.statusCode).toBe(200);
    return response.json<{ renewed: number; failed: number; expired: number; errors: number }>();
  }

  async function fetchSub(session: Session, id: string): Promise<Sub> {
    return (await call(app, session, 'GET', `/subscriptions/${id}`)).json<Sub>();
  }

  describe('POST /subscriptions', () => {
    it.each([
      ['basic', 'monthly', 10, 999],
      ['basic', 'yearly', 10, 9_990],
      ['pro', 'monthly', 100, 2_999],
      ['pro', 'yearly', 100, 29_990],
      ['enterprise', 'monthly', null, 9_999],
      ['enterprise', 'yearly', null, 99_990],
    ] as const)(
      'creates %s/%s with server-side limits and price',
      async (tier, billingCycle, maxMessages, priceCents) => {
        const alice = await login(idp, 'alice');
        const sub = await subscribe(alice, { tier, billingCycle });
        const end = addBillingCycle(clock, billingCycle);

        expect(sub).toEqual({
          id: expect.any(String) as string,
          userId: await userId(alice),
          tier,
          billingCycle,
          maxMessages,
          messagesUsed: 0,
          priceCents,
          autoRenew: true,
          status: 'active',
          startDate: iso(clock),
          endDate: iso(end),
          renewalDate: iso(end),
          cancelledAt: null,
        });
      },
    );

    it('leaves renewalDate empty when auto-renew is off', async () => {
      const sub = await subscribe(await login(idp, 'alice'), { autoRenew: false });
      expect(sub).toMatchObject({ autoRenew: false, renewalDate: null });
    });

    it.each([
      ['a price', { priceCents: 1 }],
      ['a message limit', { maxMessages: 1_000_000 }],
      ['a status', { status: 'active' }],
      ['usage', { messagesUsed: -100 }],
      ['a user id', { userId: '00000000-0000-4000-8000-000000000000' }],
      ['an unknown field', { coupon: 'FREE' }],
    ])('rejects a body that supplies %s', async (_label, extra) => {
      const response = await call(app, await login(idp, 'alice'), 'POST', '/subscriptions', {
        ...defaults,
        ...extra,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect((await pool.query('SELECT 1 FROM subscriptions')).rowCount).toBe(0);
      expect(payments.charges).toHaveLength(0);
    });

    it.each([
      ['an unknown tier', { tier: 'gold' }],
      ['an unknown cycle', { billingCycle: 'weekly' }],
      ['a non-boolean autoRenew', { autoRenew: 'yes' }],
      ['a missing tier', { tier: undefined }],
    ])('rejects %s', async (_label, override) => {
      const response = await call(app, await login(idp, 'alice'), 'POST', '/subscriptions', {
        ...defaults,
        ...override,
      });
      expect(response.statusCode).toBe(400);
    });

    it('records a declined payment and leaves no active subscription', async () => {
      decline = true;
      const response = await call(app, await login(idp, 'alice'), 'POST', '/subscriptions', {
        ...defaults,
        tier: 'pro',
      });

      expect(response.statusCode).toBe(402);
      const { subscriptionId } = response.json<{ error: { details: { subscriptionId: string } } }>()
        .error.details;
      expect(response.json()).toMatchObject({
        error: { code: 'PAYMENT_FAILED', message: 'Payment was declined' },
      });

      const { rows } = await pool.query(
        'SELECT status, auto_renew, renewal_date FROM subscriptions WHERE id = $1',
        [subscriptionId],
      );
      expect(rows).toEqual([{ status: 'inactive', auto_renew: false, renewal_date: null }]);
      expect(await paymentsFor(subscriptionId)).toMatchObject([
        { status: 'failed', amount_cents: 2_999 },
      ]);
    });

    it('stores the subscription and its payment together, consistently', async () => {
      const sub = await subscribe(await login(idp, 'alice'), {
        tier: 'pro',
        billingCycle: 'yearly',
      });

      expect(await paymentsFor(sub.id)).toEqual([
        {
          amount_cents: 29_990,
          status: 'succeeded',
          period_start: new Date(sub.startDate),
          period_end: new Date(sub.endDate),
        },
      ]);
      expect(payments.charges).toEqual([
        expect.objectContaining({
          subscriptionId: sub.id,
          amountCents: 29_990,
          idempotencyKey: `${sub.id}:${sub.startDate}`,
        }),
      ]);
    });

    it('round-trips through PostgreSQL unchanged', async () => {
      const alice = await login(idp, 'alice');
      const created = await subscribe(alice, { tier: 'enterprise' });

      expect(await fetchSub(alice, created.id)).toEqual(created);
      const { rows } = await pool.query(
        'SELECT tier, max_messages, price_cents, status FROM subscriptions WHERE id = $1',
        [created.id],
      );
      expect(rows).toEqual([
        { tier: 'enterprise', max_messages: null, price_cents: 9_999, status: 'active' },
      ]);
    });
  });

  describe('GET /subscriptions', () => {
    it('shows users only their own subscriptions', async () => {
      const alice = await login(idp, 'alice');
      const bob = await login(idp, 'bob');
      await subscribe(alice);
      await subscribe(alice, { tier: 'pro' });
      const bobs = await subscribe(bob);

      const list = (await call(app, alice, 'GET', '/subscriptions')).json<{ items: Sub[] }>();
      const aliceId = await userId(alice);

      expect(list.items).toHaveLength(2);
      expect(list.items.every((item) => item.userId === aliceId)).toBe(true);
      expect((await call(app, alice, 'GET', `/subscriptions/${bobs.id}`)).statusCode).toBe(404);
    });

    it('lets an admin list another user, or everyone', async () => {
      const admin = await login(idp, 'root', ['user', 'admin']);
      const alice = await login(idp, 'alice');
      const bob = await login(idp, 'bob');
      await subscribe(alice);
      const bobs = await subscribe(bob);

      const forBob = await call(app, admin, 'GET', `/subscriptions?userId=${bobs.userId}`);
      const all = await call(app, admin, 'GET', '/subscriptions');

      expect(forBob.json<{ items: Sub[] }>().items.map((item) => item.id)).toEqual([bobs.id]);
      expect(all.json<{ items: Sub[] }>().items).toHaveLength(2);
      expect((await call(app, admin, 'GET', `/subscriptions/${bobs.id}`)).statusCode).toBe(200);
    });

    it('answers 403 when a normal user asks for another user', async () => {
      const alice = await login(idp, 'alice');
      const bobs = await subscribe(await login(idp, 'bob'));

      const response = await call(app, alice, 'GET', `/subscriptions?userId=${bobs.userId}`);
      const own = await call(app, alice, 'GET', `/subscriptions?userId=${await userId(alice)}`);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(own.statusCode).toBe(200);
    });

    it('rejects unknown query parameters and malformed ids', async () => {
      const alice = await login(idp, 'alice');

      expect((await call(app, alice, 'GET', '/subscriptions?status=active')).statusCode).toBe(400);
      expect((await call(app, alice, 'GET', '/subscriptions?userId=bob')).statusCode).toBe(400);
      expect((await call(app, alice, 'GET', '/subscriptions/not-a-uuid')).statusCode).toBe(400);
    });
  });

  describe('PATCH /subscriptions/:id', () => {
    it('lets the owner turn auto-renew off and on again', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);

      const off = await call(app, alice, 'PATCH', `/subscriptions/${sub.id}`, { autoRenew: false });
      const on = await call(app, alice, 'PATCH', `/subscriptions/${sub.id}`, { autoRenew: true });

      expect(off.json()).toMatchObject({ autoRenew: false, renewalDate: null });
      expect(on.json()).toMatchObject({ autoRenew: true, renewalDate: sub.endDate });
      expect(await fetchSub(alice, sub.id)).toMatchObject({ autoRenew: true });
    });

    it('hides the subscription from other users and refuses admins', async () => {
      const sub = await subscribe(await login(idp, 'alice'));
      const body = { autoRenew: false };

      const stranger = await call(
        app,
        await login(idp, 'bob'),
        'PATCH',
        `/subscriptions/${sub.id}`,
        body,
      );
      const admin = await call(
        app,
        await login(idp, 'root', ['admin']),
        'PATCH',
        `/subscriptions/${sub.id}`,
        body,
      );

      expect(stranger.statusCode).toBe(404);
      expect(admin.statusCode).toBe(403);
      expect(await fetchSub(await login(idp, 'alice'), sub.id)).toMatchObject({ autoRenew: true });
    });

    it.each([
      ['an empty body', {}],
      ['a non-boolean', { autoRenew: 'no' }],
      ['a tier change', { autoRenew: true, tier: 'enterprise' }],
      ['a status change', { status: 'active' }],
      ['a date change', { autoRenew: true, endDate: '2099-01-01T00:00:00.000Z' }],
      ['a usage change', { autoRenew: true, messagesUsed: 0 }],
    ])('rejects %s', async (_label, body) => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);

      const response = await call(app, alice, 'PATCH', `/subscriptions/${sub.id}`, body);
      expect(response.statusCode).toBe(400);
      expect(await fetchSub(alice, sub.id)).toEqual(sub);
    });
  });

  describe('POST /subscriptions/:id/cancel', () => {
    it('stops renewal but keeps the current period and usage', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);
      await pool.query('UPDATE subscriptions SET messages_used = 4 WHERE id = $1', [sub.id]);

      const response = await call(app, alice, 'POST', `/subscriptions/${sub.id}/cancel`);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'active',
        autoRenew: false,
        renewalDate: null,
        cancelledAt: iso(clock),
        endDate: sub.endDate,
        messagesUsed: 4,
      });
    });

    it('is idempotent', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);
      const first = (await call(app, alice, 'POST', `/subscriptions/${sub.id}/cancel`)).json<Sub>();
      clock = new Date(clock.getTime() + 60_000);
      const again = await call(app, alice, 'POST', `/subscriptions/${sub.id}/cancel`);

      expect(again.statusCode).toBe(200);
      expect(again.json<Sub>().cancelledAt).toBe(first.cancelledAt);
    });

    it('hides the subscription from other users and refuses admins', async () => {
      const sub = await subscribe(await login(idp, 'alice'));
      const url = `/subscriptions/${sub.id}/cancel`;

      expect((await call(app, await login(idp, 'bob'), 'POST', url)).statusCode).toBe(404);
      expect((await call(app, await login(idp, 'root', ['admin']), 'POST', url)).statusCode).toBe(
        403,
      );
    });

    it('cannot be undone by turning auto-renew back on', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);
      await call(app, alice, 'POST', `/subscriptions/${sub.id}/cancel`);

      const response = await call(app, alice, 'PATCH', `/subscriptions/${sub.id}`, {
        autoRenew: true,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_CANCELLED' } });
    });

    it('stays usable until endDate, then expires without being renewed or charged', async () => {
      const alice = await login(idp, 'alice');
      const admin = await login(idp, 'root', ['admin']);
      const sub = await subscribe(alice);
      await call(app, alice, 'POST', `/subscriptions/${sub.id}/cancel`);

      clock = new Date(new Date(sub.endDate).getTime() - 1);
      expect(await runBilling(admin)).toMatchObject({ renewed: 0, expired: 0 });
      expect(await fetchSub(alice, sub.id)).toMatchObject({ status: 'active' });

      clock = new Date(sub.endDate);
      expect(await runBilling(admin)).toMatchObject({ renewed: 0, expired: 1 });
      expect(await fetchSub(alice, sub.id)).toMatchObject({ status: 'inactive' });
      expect(await paymentsFor(sub.id)).toHaveLength(1);
      expect(payments.charges).toHaveLength(1);
    });
  });

  describe('POST /admin/billing/run', () => {
    it('is admin-only', async () => {
      const response = await call(app, await login(idp, 'alice'), 'POST', '/admin/billing/run');
      expect(response.statusCode).toBe(403);
    });

    it('renews due subscriptions, resets usage and records the payment', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice, { tier: 'pro' });
      await pool.query('UPDATE subscriptions SET messages_used = 37 WHERE id = $1', [sub.id]);
      const nextEnd = addBillingCycle(new Date(sub.endDate), 'monthly');

      clock = new Date(sub.endDate);
      expect(await runBilling(await login(idp, 'root', ['admin']))).toEqual({
        renewed: 1,
        failed: 0,
        expired: 0,
        errors: 0,
      });

      expect(await fetchSub(alice, sub.id)).toMatchObject({
        status: 'active',
        messagesUsed: 0,
        startDate: sub.endDate,
        endDate: iso(nextEnd),
        renewalDate: iso(nextEnd),
      });
      expect(await paymentsFor(sub.id)).toEqual([
        expect.objectContaining({ status: 'succeeded', period_start: new Date(sub.startDate) }),
        {
          amount_cents: 2_999,
          status: 'succeeded',
          period_start: new Date(sub.endDate),
          period_end: nextEnd,
        },
      ]);
    });

    it('deactivates a subscription whose renewal payment fails, keeping history', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice);
      await pool.query('UPDATE subscriptions SET messages_used = 9 WHERE id = $1', [sub.id]);

      decline = true;
      clock = new Date(sub.endDate);
      expect(await runBilling(await login(idp, 'root', ['admin']))).toMatchObject({
        renewed: 0,
        failed: 1,
      });

      expect(await fetchSub(alice, sub.id)).toMatchObject({
        status: 'inactive',
        autoRenew: false,
        renewalDate: null,
        messagesUsed: 9,
      });
      expect((await paymentsFor(sub.id)).map((payment) => payment.status)).toEqual([
        'succeeded',
        'failed',
      ]);
    });

    it('expires a finished subscription with auto-renew off, without charging', async () => {
      const alice = await login(idp, 'alice');
      const sub = await subscribe(alice, { autoRenew: false });

      clock = new Date(sub.endDate);
      expect(await runBilling(await login(idp, 'root', ['admin']))).toMatchObject({
        expired: 1,
        renewed: 0,
      });
      expect(await fetchSub(alice, sub.id)).toMatchObject({ status: 'inactive' });
      expect(await paymentsFor(sub.id)).toHaveLength(1);
    });

    it('leaves subscriptions that are not due alone', async () => {
      const sub = await subscribe(await login(idp, 'alice'));

      clock = new Date(new Date(sub.endDate).getTime() - 1);
      expect(await runBilling(await login(idp, 'root', ['admin']))).toEqual({
        renewed: 0,
        failed: 0,
        expired: 0,
        errors: 0,
      });
    });

    it('keeps every historical payment across renewals', async () => {
      const alice = await login(idp, 'alice');
      const admin = await login(idp, 'root', ['admin']);
      const sub = await subscribe(alice);

      clock = new Date(sub.endDate);
      await runBilling(admin);
      decline = true;
      clock = new Date((await fetchSub(alice, sub.id)).endDate);
      await runBilling(admin);

      expect((await paymentsFor(sub.id)).map((payment) => payment.status)).toEqual([
        'succeeded',
        'succeeded',
        'failed',
      ]);
    });

    it('does not charge twice when a period was already charged before a crash', async () => {
      const sub = await subscribe(await login(idp, 'alice'));
      // Simulates a run that charged but died before committing the renewal.
      await payments.charge({
        subscriptionId: sub.id,
        userId: sub.userId,
        amountCents: sub.priceCents,
        idempotencyKey: `${sub.id}:${sub.endDate}`,
      });

      clock = new Date(sub.endDate);
      expect(await runBilling(await login(idp, 'root', ['admin']))).toMatchObject({ renewed: 1 });
      expect(payments.charges.filter((charge) => charge.subscriptionId === sub.id)).toHaveLength(2);
    });

    it('never renews or charges a subscription twice when billing runs concurrently', async () => {
      await app.close();
      app = await startApp(40);
      const admin = await login(idp, 'root', ['admin']);
      const subs = await Promise.all(
        ['a', 'b', 'c', 'd', 'e', 'f'].map(async (name) => subscribe(await login(idp, name))),
      );

      clock = new Date(subs[0]!.endDate);
      const [first, second] = await Promise.all([runBilling(admin), runBilling(admin)]);

      expect(first.renewed + second.renewed).toBe(subs.length);
      for (const sub of subs) {
        expect((await paymentsFor(sub.id)).map((payment) => payment.status)).toEqual([
          'succeeded',
          'succeeded',
        ]);
      }
      // One initial and one renewal charge per subscription, nothing more.
      expect(payments.charges).toHaveLength(subs.length * 2);
    });
  });
});
