import type { Pool, PoolClient } from 'pg';

import type { Tier } from '../../subscriptions/domain/entities/tiers.js';
import type { Bundle } from '../domain/services/quota.js';

// `period` is a DATE column. Pass 'YYYY-MM-DD' strings: pg would serialize a JS Date in the
// server's local timezone, which can shift the month.
const day = (month: Date): string => month.toISOString().slice(0, 10);

/** Serializes all quota changes for one user. Returns false if the user does not exist. */
export async function lockUser(db: PoolClient, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
  return rowCount === 1;
}

/** Ensures the month's usage row exists, locks it and returns free messages used. */
export async function lockMonthlyUsage(
  db: PoolClient,
  userId: string,
  month: Date,
): Promise<number> {
  await db.query(
    `INSERT INTO monthly_usage (user_id, period) VALUES ($1, $2)
     ON CONFLICT (user_id, period) DO NOTHING`,
    [userId, day(month)],
  );
  const { rows } = await db.query<{ free_used: number }>(
    'SELECT free_used FROM monthly_usage WHERE user_id = $1 AND period = $2 FOR UPDATE',
    [userId, day(month)],
  );
  return rows[0]?.free_used ?? 0;
}

/** Locks the user's subscriptions that are usable at `now`, in id order to avoid deadlocks. */
export async function lockUsableBundles(
  db: PoolClient,
  userId: string,
  now: Date,
): Promise<Bundle[]> {
  const { rows } = await db.query<{
    id: string;
    status: Bundle['status'];
    start_date: Date;
    end_date: Date;
    max_messages: number | null;
    messages_used: number;
  }>(
    `SELECT id, status, start_date, end_date, max_messages, messages_used
     FROM subscriptions
     WHERE user_id = $1 AND status = 'active' AND start_date <= $2 AND end_date > $2
     ORDER BY id
     FOR UPDATE`,
    [userId, now],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    maxMessages: row.max_messages,
    messagesUsed: row.messages_used,
  }));
}

// The increments below re-check the limit in SQL, so even a caller that skipped the locks
// could not push a counter past its quota.

export async function addFreeUse(
  db: PoolClient,
  userId: string,
  month: Date,
  limit: number,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE monthly_usage SET free_used = free_used + 1, total_used = total_used + 1
     WHERE user_id = $1 AND period = $2 AND free_used < $3`,
    [userId, day(month), limit],
  );
  return rowCount === 1;
}

/** Returns the bundle's current period start, or null if it could not take another message. */
export async function addBundleUse(
  db: PoolClient,
  subscriptionId: string,
  now: Date,
): Promise<Date | null> {
  const { rows } = await db.query<{ start_date: Date }>(
    `UPDATE subscriptions SET messages_used = messages_used + 1, updated_at = now()
     WHERE id = $1 AND status = 'active' AND start_date <= $2 AND end_date > $2
       AND (max_messages IS NULL OR messages_used < max_messages)
     RETURNING start_date`,
    [subscriptionId, now],
  );
  return rows[0]?.start_date ?? null;
}

export async function addMonthlyTotal(db: PoolClient, userId: string, month: Date): Promise<void> {
  await db.query(
    'UPDATE monthly_usage SET total_used = total_used + 1 WHERE user_id = $1 AND period = $2',
    [userId, day(month)],
  );
}

export async function removeFreeUse(db: PoolClient, userId: string, month: Date): Promise<void> {
  await db.query(
    `UPDATE monthly_usage SET free_used = free_used - 1, total_used = total_used - 1
     WHERE user_id = $1 AND period = $2 AND free_used > 0`,
    [userId, day(month)],
  );
}

/**
 * Only refunds into the period the message was taken from: if the bundle renewed in the
 * meantime, its usage was already reset and there is nothing to give back.
 */
export async function removeBundleUse(
  db: PoolClient,
  subscriptionId: string,
  periodStart: Date,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE subscriptions SET messages_used = messages_used - 1, updated_at = now()
     WHERE id = $1 AND start_date = $2 AND messages_used > 0`,
    [subscriptionId, periodStart],
  );
  return rowCount === 1;
}

export async function removeMonthlyTotal(
  db: PoolClient,
  userId: string,
  month: Date,
): Promise<void> {
  await db.query(
    `UPDATE monthly_usage SET total_used = total_used - 1
     WHERE user_id = $1 AND period = $2 AND total_used > free_used`,
    [userId, day(month)],
  );
}

// Read-only views for GET /chat/usage; no locks, the numbers are informational.

export async function readMonthlyUsage(
  db: Pool,
  userId: string,
  month: Date,
): Promise<{ freeUsed: number; totalUsed: number }> {
  const { rows } = await db.query<{ free_used: number; total_used: number }>(
    'SELECT free_used, total_used FROM monthly_usage WHERE user_id = $1 AND period = $2',
    [userId, day(month)],
  );
  return { freeUsed: rows[0]?.free_used ?? 0, totalUsed: rows[0]?.total_used ?? 0 };
}

export async function listUsableSubscriptions(
  db: Pool,
  userId: string,
  now: Date,
): Promise<(Bundle & { tier: Tier })[]> {
  const { rows } = await db.query<{
    id: string;
    tier: Tier;
    status: Bundle['status'];
    start_date: Date;
    end_date: Date;
    max_messages: number | null;
    messages_used: number;
  }>(
    `SELECT id, tier, status, start_date, end_date, max_messages, messages_used
     FROM subscriptions
     WHERE user_id = $1 AND status = 'active' AND start_date <= $2 AND end_date > $2
     ORDER BY start_date DESC, id`,
    [userId, now],
  );
  return rows.map((row) => ({
    id: row.id,
    tier: row.tier,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    maxMessages: row.max_messages,
    messagesUsed: row.messages_used,
  }));
}
