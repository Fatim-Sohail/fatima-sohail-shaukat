import type { Pool, PoolClient } from 'pg';

import type { Subscription } from '../domain/entities/subscription.js';
import type { BillingCycle, Tier } from '../domain/entities/tiers.js';
import type { PaymentRecord } from '../domain/services/billing.js';

type Db = Pool | PoolClient;

interface Row {
  id: string;
  user_id: string;
  tier: Tier;
  billing_cycle: BillingCycle;
  max_messages: number | null;
  messages_used: number;
  price_cents: number;
  auto_renew: boolean;
  status: Subscription['status'];
  start_date: Date;
  end_date: Date;
  renewal_date: Date | null;
  cancelled_at: Date | null;
}

const COLUMNS = `id, user_id, tier, billing_cycle, max_messages, messages_used, price_cents,
  auto_renew, status, start_date, end_date, renewal_date, cancelled_at`;

function toSubscription(row: Row): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    billingCycle: row.billing_cycle,
    maxMessages: row.max_messages,
    messagesUsed: row.messages_used,
    priceCents: row.price_cents,
    autoRenew: row.auto_renew,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    renewalDate: row.renewal_date,
    cancelledAt: row.cancelled_at,
  };
}

export async function insertSubscription(db: Db, sub: Subscription): Promise<void> {
  await db.query(
    `INSERT INTO subscriptions (${COLUMNS})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      sub.id,
      sub.userId,
      sub.tier,
      sub.billingCycle,
      sub.maxMessages,
      sub.messagesUsed,
      sub.priceCents,
      sub.autoRenew,
      sub.status,
      sub.startDate,
      sub.endDate,
      sub.renewalDate,
      sub.cancelledAt,
    ],
  );
}

/** Writes the mutable state back. Callers hold the row lock (see findForUpdate). */
export async function updateSubscription(db: Db, sub: Subscription): Promise<void> {
  await db.query(
    `UPDATE subscriptions
     SET messages_used = $2, auto_renew = $3, status = $4, start_date = $5, end_date = $6,
         renewal_date = $7, cancelled_at = $8, updated_at = now()
     WHERE id = $1`,
    [
      sub.id,
      sub.messagesUsed,
      sub.autoRenew,
      sub.status,
      sub.startDate,
      sub.endDate,
      sub.renewalDate,
      sub.cancelledAt,
    ],
  );
}

export async function findSubscription(db: Db, id: string): Promise<Subscription | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM subscriptions WHERE id = $1`, [id]);
  return rows[0] ? toSubscription(rows[0]) : null;
}

/** Locks the row until the surrounding transaction ends, so concurrent changes serialize. */
export async function findForUpdate(db: PoolClient, id: string): Promise<Subscription | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM subscriptions WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

export interface Page {
  limit: number;
  offset: number;
}

/** Newest first. Without a userId, lists every user's subscriptions (admin view). */
export async function listSubscriptions(
  db: Db,
  userId: string | undefined,
  page: Page,
): Promise<Subscription[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM subscriptions
     WHERE $1::uuid IS NULL OR user_id = $1
     ORDER BY created_at DESC, id
     LIMIT $2 OFFSET $3`,
    [userId ?? null, page.limit, page.offset],
  );
  return rows.map(toSubscription);
}

/**
 * Locks one subscription that billing has to act on: an auto-renewal that is due, or a
 * finished period that won't renew. SKIP LOCKED lets parallel billing runs share the work
 * instead of queueing on (and re-billing) the same row.
 */
export async function lockNextDue(
  db: PoolClient,
  now: Date,
  skipIds: readonly string[],
): Promise<Subscription | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM subscriptions
     WHERE status = 'active'
       AND ((auto_renew AND renewal_date <= $1) OR (NOT auto_renew AND end_date <= $1))
       AND NOT (id = ANY($2::uuid[]))
     ORDER BY end_date, id
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [now, skipIds],
  );
  return rows[0] ? toSubscription(rows[0]) : null;
}

export async function insertPayment(
  db: Db,
  subscriptionId: string,
  payment: PaymentRecord,
): Promise<void> {
  await db.query(
    `INSERT INTO payments (subscription_id, amount_cents, status, period_start, period_end)
     VALUES ($1, $2, $3, $4, $5)`,
    [subscriptionId, payment.amountCents, payment.status, payment.periodStart, payment.periodEnd],
  );
}
