import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { askQuestion, type ChatDeps } from '../../src/modules/chat/application/askQuestion.js';
import {
  refundQuota,
  reserveQuota,
  type Reservation,
} from '../../src/modules/chat/application/quota.js';
import type { AiProvider } from '../../src/modules/chat/domain/services/aiProvider.js';
import { createMockAiProvider } from '../../src/modules/chat/infrastructure/mockAiProvider.js';
import { createPool } from '../../src/shared/db/pool.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const OCTOBER = '2026-10-01';
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

const exhausted = expect.objectContaining({
  kind: 'payment_required',
  code: 'QUOTA_EXHAUSTED',
}) as Error;

describe('quota reservation (PostgreSQL)', () => {
  let pool: Pool;
  let userId: string;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });
  afterEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  async function createUser(subject = 'alice'): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (idp_issuer, idp_subject) VALUES ('https://idp.test', $1) RETURNING id`,
      [subject],
    );
    return rows[0]!.id;
  }

  async function addBundle(
    owner: string,
    options: {
      maxMessages?: number | null;
      messagesUsed?: number;
      status?: 'active' | 'inactive';
      start?: Date;
      end?: Date;
    } = {},
  ): Promise<string> {
    const maxMessages = options.maxMessages === undefined ? 10 : options.maxMessages;
    const tier = maxMessages === null ? 'enterprise' : maxMessages > 10 ? 'pro' : 'basic';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, tier, billing_cycle, max_messages, messages_used,
         price_cents, auto_renew, status, start_date, end_date)
       VALUES ($1, $2, 'monthly', $3, $4, 999, false, $5, $6, $7) RETURNING id`,
      [
        owner,
        tier,
        maxMessages,
        options.messagesUsed ?? 0,
        options.status ?? 'active',
        options.start ?? days(-10),
        options.end ?? days(20),
      ],
    );
    return rows[0]!.id;
  }

  async function setFreeUsed(owner: string, freeUsed: number): Promise<void> {
    await pool.query(
      'INSERT INTO monthly_usage (user_id, period, free_used, total_used) VALUES ($1, $2, $3, $3)',
      [owner, OCTOBER, freeUsed],
    );
  }

  async function usage(owner: string, period = OCTOBER) {
    const { rows } = await pool.query<{ free_used: number; total_used: number }>(
      'SELECT free_used, total_used FROM monthly_usage WHERE user_id = $1 AND period = $2',
      [owner, period],
    );
    return rows[0];
  }

  async function messagesUsed(subscriptionId: string): Promise<number> {
    const { rows } = await pool.query<{ messages_used: number }>(
      'SELECT messages_used FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    return rows[0]!.messages_used;
  }

  const reserve = (now = NOW): Promise<Reservation> => reserveQuota(pool, userId, now);

  describe('reserveQuota', () => {
    it('uses the 3 free messages first, even when a subscription exists', async () => {
      userId = await createUser();
      const basic = await addBundle(userId);

      for (let i = 0; i < 3; i++) {
        expect(await reserve()).toMatchObject({ source: 'free' });
      }
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
      expect(await messagesUsed(basic)).toBe(0);
    });

    it('takes the 4th message from the subscription and counts it for the month', async () => {
      userId = await createUser();
      const basic = await addBundle(userId);
      await setFreeUsed(userId, 3);

      expect(await reserve()).toMatchObject({ source: 'subscription', subscriptionId: basic });
      expect(await messagesUsed(basic)).toBe(1);
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 4 });
    });

    it('uses the bundle with the most messages left', async () => {
      userId = await createUser();
      const basic = await addBundle(userId, { maxMessages: 10, messagesUsed: 2 });
      const pro = await addBundle(userId, { maxMessages: 100, messagesUsed: 95 });
      await setFreeUsed(userId, 3);

      expect(await reserve()).toMatchObject({ subscriptionId: basic });
      expect(await messagesUsed(basic)).toBe(3);
      expect(await messagesUsed(pro)).toBe(95);
    });

    it('treats Enterprise as unlimited', async () => {
      userId = await createUser();
      await addBundle(userId, { maxMessages: 100 });
      const enterprise = await addBundle(userId, { maxMessages: null, messagesUsed: 1_000_000 });
      await setFreeUsed(userId, 3);

      expect(await reserve()).toMatchObject({ subscriptionId: enterprise });
      expect(await messagesUsed(enterprise)).toBe(1_000_001);
    });

    it('ignores inactive and expired subscriptions', async () => {
      userId = await createUser();
      const inactive = await addBundle(userId, { maxMessages: 100, status: 'inactive' });
      const expired = await addBundle(userId, {
        maxMessages: 100,
        start: days(-40),
        end: days(-10),
      });
      const basic = await addBundle(userId, { messagesUsed: 9 });
      await setFreeUsed(userId, 3);

      expect(await reserve()).toMatchObject({ subscriptionId: basic });
      await expect(reserve()).rejects.toThrow(exhausted);
      expect(await messagesUsed(inactive)).toBe(0);
      expect(await messagesUsed(expired)).toBe(0);
    });

    it('fails with QUOTA_EXHAUSTED and changes nothing when no quota is left', async () => {
      userId = await createUser();
      const usedUp = await addBundle(userId, { messagesUsed: 10 });
      await setFreeUsed(userId, 3);

      await expect(reserve()).rejects.toThrow(exhausted);
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
      expect(await messagesUsed(usedUp)).toBe(10);
    });

    it('starts a new month with fresh free quota', async () => {
      userId = await createUser();
      await setFreeUsed(userId, 3);

      expect(await reserve(new Date('2026-11-01T00:00:00.000Z'))).toMatchObject({
        source: 'free',
      });
      expect(await usage(userId, '2026-11-01')).toEqual({ free_used: 1, total_used: 1 });
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
    });
  });

  describe('refundQuota', () => {
    it('gives back a free message', async () => {
      userId = await createUser();
      const reservation = await reserve();
      await refundQuota(pool, reservation);

      expect(await usage(userId)).toEqual({ free_used: 0, total_used: 0 });
    });

    it('gives back a subscription message and its monthly count', async () => {
      userId = await createUser();
      const basic = await addBundle(userId, { messagesUsed: 4 });
      await setFreeUsed(userId, 3);

      await refundQuota(pool, await reserve());

      expect(await messagesUsed(basic)).toBe(4);
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
    });

    it('never makes counters negative, even if refunded twice', async () => {
      userId = await createUser();
      const free = await reserve();
      await refundQuota(pool, free);
      await refundQuota(pool, free);
      expect(await usage(userId)).toEqual({ free_used: 0, total_used: 0 });

      const basic = await addBundle(userId);
      await pool.query(
        'UPDATE monthly_usage SET free_used = 3, total_used = 3 WHERE user_id = $1',
        [userId],
      );
      const paid = await reserve();
      await refundQuota(pool, paid);
      await refundQuota(pool, paid);
      expect(await messagesUsed(basic)).toBe(0);
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
    });

    it('does not refund into a new period after the bundle renewed', async () => {
      userId = await createUser();
      const basic = await addBundle(userId);
      await setFreeUsed(userId, 3);
      const reservation = await reserve();

      // Billing renewed the bundle meanwhile: new period, usage reset.
      await pool.query(
        'UPDATE subscriptions SET start_date = $2, end_date = $3, messages_used = 0 WHERE id = $1',
        [basic, days(1), days(31)],
      );
      await refundQuota(pool, reservation);

      expect(await messagesUsed(basic)).toBe(0);
    });
  });

  describe('askQuestion', () => {
    const deps = (ai: AiProvider): ChatDeps => ({ pool, ai, now: () => NOW });

    it('returns the answer with token counts and keeps the reservation', async () => {
      userId = await createUser();
      const result = await askQuestion(
        deps(createMockAiProvider({ latencyMs: 5 })),
        userId,
        'What is a DPoP proof?',
      );

      expect(result.reservation).toMatchObject({ source: 'free', userId });
      expect(result.reply).toMatchObject({
        promptTokens: expect.any(Number) as number,
        completionTokens: expect.any(Number) as number,
      });
      expect(result.reply.totalTokens).toBe(
        result.reply.promptTokens + result.reply.completionTokens,
      );
      expect(await usage(userId)).toEqual({ free_used: 1, total_used: 1 });
    });

    it('refunds the reservation and hides provider details when the AI fails', async () => {
      userId = await createUser();
      const failing = createMockAiProvider({ latencyMs: 5, failureRate: 1 });

      const error: unknown = await askQuestion(deps(failing), userId, 'Hello?').catch(
        (rejected: unknown) => rejected,
      );

      expect(error).toMatchObject({
        kind: 'unavailable',
        code: 'AI_UNAVAILABLE',
        message: 'The AI service is unavailable, retry later',
      });
      expect((error as Error).message).not.toContain('mock');
      expect(await usage(userId)).toEqual({ free_used: 0, total_used: 0 });
    });

    it('refunds the reservation when the call is aborted', async () => {
      userId = await createUser();
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 20);

      await expect(
        askQuestion(
          deps(createMockAiProvider({ latencyMs: 5_000 })),
          userId,
          'Hello?',
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
      expect(await usage(userId)).toEqual({ free_used: 0, total_used: 0 });
    });

    it('holds no locks or transaction while the AI is answering', async () => {
      userId = await createUser();
      const basic = await addBundle(userId);
      await setFreeUsed(userId, 3);

      const probe: AiProvider = {
        async ask() {
          // From another connection, every row the reservation touched must be free to lock.
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE NOWAIT', [userId]);
            await client.query('SELECT 1 FROM monthly_usage WHERE user_id = $1 FOR UPDATE NOWAIT', [
              userId,
            ]);
            await client.query('SELECT 1 FROM subscriptions WHERE id = $1 FOR UPDATE NOWAIT', [
              basic,
            ]);
            const { rows } = await client.query<{ open: string }>(
              `SELECT count(*) AS open FROM pg_stat_activity
               WHERE datname = current_database() AND pid <> pg_backend_pid()
                 AND state LIKE 'idle in transaction%'`,
            );
            expect(Number(rows[0]!.open)).toBe(0);
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
          return {
            answer: 'ok',
            model: 'probe',
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          };
        },
      };

      await expect(askQuestion(deps(probe), userId, 'Hi')).resolves.toMatchObject({
        reservation: { source: 'subscription', subscriptionId: basic },
      });
    });
  });

  describe('concurrency', () => {
    it('lets exactly 3 of 10 parallel requests use the free quota', async () => {
      userId = await createUser();

      const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve()));

      const succeeded = results.filter((result) => result.status === 'fulfilled');
      const failed = results.filter((result) => result.status === 'rejected');
      expect(succeeded).toHaveLength(3);
      for (const result of failed) {
        expect(result.reason).toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      }
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 3 });
    });

    it('never lets a limited subscription go past maxMessages', async () => {
      userId = await createUser();
      const basic = await addBundle(userId, { maxMessages: 10 });
      await setFreeUsed(userId, 3);

      const results = await Promise.allSettled(Array.from({ length: 15 }, () => reserve()));

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        expect(result.reason).toMatchObject({ code: 'QUOTA_EXHAUSTED' });
      }
      expect(await messagesUsed(basic)).toBe(10);
      expect(await usage(userId)).toEqual({ free_used: 3, total_used: 13 });
    });
  });
});
