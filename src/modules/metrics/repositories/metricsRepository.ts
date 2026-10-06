import type { Pool } from 'pg';

import { TIERS, type Tier } from '../../subscriptions/domain/entities/tiers.js';

export interface Metrics {
  users: number;
  chatsThisMonth: number;
  activeSubscriptions: Record<Tier, number>;
  payments: { succeeded: number; failed: number };
}

/** Counts for one UTC month [monthStart, nextMonthStart); "active" means status active and not yet ended. */
export async function readMetrics(
  pool: Pool,
  range: { monthStart: Date; nextMonthStart: Date; now: Date },
): Promise<Metrics> {
  const [totals, tiers] = await Promise.all([
    pool.query<{ users: string; chats: string; succeeded: string; failed: string }>(
      `SELECT
         (SELECT count(*) FROM users) AS users,
         (SELECT count(*) FROM chat_messages WHERE created_at >= $1 AND created_at < $2) AS chats,
         (SELECT count(*) FROM payments WHERE status = 'succeeded') AS succeeded,
         (SELECT count(*) FROM payments WHERE status = 'failed') AS failed`,
      [range.monthStart, range.nextMonthStart],
    ),
    pool.query<{ tier: Tier; count: string }>(
      `SELECT tier, count(*) FROM subscriptions
       WHERE status = 'active' AND end_date > $1
       GROUP BY tier`,
      [range.now],
    ),
  ]);

  const activeSubscriptions = Object.fromEntries(TIERS.map((tier) => [tier, 0])) as Record<
    Tier,
    number
  >;
  for (const row of tiers.rows) {
    activeSubscriptions[row.tier] = Number(row.count);
  }

  const row = totals.rows[0];
  return {
    users: Number(row?.users ?? 0),
    chatsThisMonth: Number(row?.chats ?? 0),
    activeSubscriptions,
    payments: { succeeded: Number(row?.succeeded ?? 0), failed: Number(row?.failed ?? 0) },
  };
}
