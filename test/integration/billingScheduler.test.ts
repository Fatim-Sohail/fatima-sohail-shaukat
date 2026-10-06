import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { billDueSubscriptions } from '../../src/modules/subscriptions/application/billingRun.js';
import { startBillingScheduler } from '../../src/modules/subscriptions/infrastructure/billingScheduler.js';
import { createMockPaymentGateway } from '../../src/modules/subscriptions/infrastructure/mockPaymentGateway.js';
import { createPool } from '../../src/shared/db/pool.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const PERIOD_END = new Date('2026-10-15T11:00:00.000Z');

describe('billing scheduler (PostgreSQL)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(TEST_DATABASE_URL);
  });
  afterEach(async () => {
    await pool.query('TRUNCATE users, subscriptions, payments CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  it('renews a due auto-renew subscription on its first run', async () => {
    const { rows: users } = await pool.query<{ id: string }>(
      `INSERT INTO users (idp_issuer, idp_subject) VALUES ('https://idp.test', 'alice') RETURNING id`,
    );
    const { rows: subs } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, tier, billing_cycle, max_messages, messages_used,
         price_cents, auto_renew, status, start_date, end_date, renewal_date)
       VALUES ($1, 'basic', 'monthly', 10, 6, 999, true, 'active', $2, $3, $3) RETURNING id`,
      [users[0]!.id, new Date('2026-09-15T11:00:00.000Z'), PERIOD_END],
    );
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const stop = startBillingScheduler({
      run: () =>
        billDueSubscriptions({
          pool,
          payments: createMockPaymentGateway({ failureRate: 0 }),
          now: () => NOW,
        }),
      intervalMs: 3_600_000,
      log,
    });
    // Resolves once the immediate startup run has finished.
    await stop();

    const { rows } = await pool.query(
      'SELECT status, messages_used, start_date, end_date FROM subscriptions WHERE id = $1',
      [subs[0]!.id],
    );
    expect(rows).toEqual([
      {
        status: 'active',
        messages_used: 0,
        start_date: PERIOD_END,
        end_date: new Date('2026-11-15T11:00:00.000Z'),
      },
    ]);
    const payments = await pool.query('SELECT status, amount_cents FROM payments');
    expect(payments.rows).toEqual([{ status: 'succeeded', amount_cents: 999 }]);
    expect(log.info).toHaveBeenCalledWith(
      { billing: { renewed: 1, failed: 0, expired: 0, errors: 0 } },
      'billing run completed',
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});
