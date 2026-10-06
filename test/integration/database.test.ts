import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../../src/shared/db/pool.js';
import { withTransaction } from '../../src/shared/db/transaction.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

describe('database foundation', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });
  afterEach(async () => {
    await pool.query('TRUNCATE users CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  async function insertUser(db: Pool | PoolClient, subject = 'user-1'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (idp_issuer, idp_subject) VALUES ('https://idp.test', $1) RETURNING id`,
      [subject],
    );
    return rows[0]!.id;
  }

  async function countUsers(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM users');
    return Number(rows[0]!.count);
  }

  describe('withTransaction', () => {
    it('commits the work and returns its result', async () => {
      const id = await withTransaction(pool, (client) => insertUser(client));

      expect(id).toEqual(expect.any(String));
      expect(await countUsers()).toBe(1);
    });

    it('rolls back everything and rethrows when the work fails', async () => {
      const failure = new Error('boom');

      await expect(
        withTransaction(pool, async (client) => {
          await insertUser(client, 'user-a');
          await insertUser(client, 'user-b');
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await countUsers()).toBe(0);
    });
  });

  describe('schema constraints', () => {
    async function insertSubscription(values: {
      tier: string;
      maxMessages: number | null;
      messagesUsed?: number;
    }): Promise<void> {
      const userId = await insertUser(pool);
      await pool.query(
        `INSERT INTO subscriptions
           (user_id, tier, billing_cycle, max_messages, messages_used, price_cents,
            auto_renew, status, start_date, end_date)
         VALUES ($1, $2, 'monthly', $3, $4, 1000, false, 'active', now(), now() + interval '1 month')`,
        [userId, values.tier, values.maxMessages, values.messagesUsed ?? 0],
      );
    }

    it('stores enterprise bundles as unlimited (NULL max_messages)', async () => {
      await expect(insertSubscription({ tier: 'enterprise', maxMessages: null })).resolves.toBe(
        undefined,
      );
    });

    it.each([
      ['a limited tier without a limit', { tier: 'basic', maxMessages: null }],
      ['an enterprise tier with a limit', { tier: 'enterprise', maxMessages: 10 }],
      ['usage beyond the limit', { tier: 'basic', maxMessages: 10, messagesUsed: 11 }],
    ])('rejects %s', async (_label, values) => {
      await expect(insertSubscription(values)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it('caps free monthly usage at 3 and only accepts month-start periods', async () => {
      const userId = await insertUser(pool);
      const insertUsage = (period: string, freeUsed: number) =>
        pool.query(
          'INSERT INTO monthly_usage (user_id, period, free_used, total_used) VALUES ($1, $2, $3, $3)',
          [userId, period, freeUsed],
        );

      await expect(insertUsage('2026-10-01', 4)).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insertUsage('2026-10-15', 1)).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insertUsage('2026-10-01', 3)).resolves.toBeDefined();
    });

    it('requires chat messages to reference an existing user', async () => {
      await expect(
        pool.query(
          `INSERT INTO chat_messages
             (user_id, question, answer, model, prompt_tokens, completion_tokens, total_tokens,
              quota_source, request_id)
           VALUES (gen_random_uuid(), 'q', 'a', 'mock', 1, 1, 2, 'free', 'req-1')`,
        ),
      ).rejects.toMatchObject({ code: FOREIGN_KEY_VIOLATION });
    });

    it('identifies users uniquely per issuer and subject', async () => {
      await insertUser(pool, 'same-subject');
      await expect(insertUser(pool, 'same-subject')).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });
  });
});
