import type { Pool } from 'pg';

import { withTransaction } from '../../../shared/db/transaction.js';
import { decideQuota, FREE_MESSAGES_PER_MONTH, monthStart } from '../domain/services/quota.js';
import * as repo from '../repositories/quotaRepository.js';

/** Quota taken for one message; enough to refund exactly that message. */
export type Reservation =
  | { source: 'free'; userId: string; month: Date }
  | {
      source: 'subscription';
      userId: string;
      month: Date;
      subscriptionId: string;
      periodStart: Date;
    };

/**
 * Takes one message of quota in a single short transaction. Locks are taken in a fixed
 * order (user, then monthly usage, then bundles by id), and the user lock serializes
 * concurrent requests from the same user so each one decides on committed counters.
 */
export function reserveQuota(pool: Pool, userId: string, now: Date): Promise<Reservation> {
  const month = monthStart(now);

  return withTransaction(pool, async (client) => {
    if (!(await repo.lockUser(client, userId))) {
      throw new Error(`user ${userId} not found`);
    }
    const freeUsed = await repo.lockMonthlyUsage(client, userId, month);
    const bundles = await repo.lockUsableBundles(client, userId, now);

    const decision = decideQuota({ freeUsed, bundles, now });

    if (decision.source === 'free') {
      if (!(await repo.addFreeUse(client, userId, month, FREE_MESSAGES_PER_MONTH))) {
        throw new Error('free quota changed during reservation');
      }
      return { source: 'free', userId, month };
    }

    const periodStart = await repo.addBundleUse(client, decision.subscriptionId, now);
    if (!periodStart) {
      throw new Error('subscription quota changed during reservation');
    }
    await repo.addMonthlyTotal(client, userId, month);
    return {
      source: 'subscription',
      userId,
      month,
      subscriptionId: decision.subscriptionId,
      periodStart,
    };
  });
}

/** Gives back exactly the reserved message. Counters never go below zero. */
export async function refundQuota(pool: Pool, reservation: Reservation): Promise<void> {
  await withTransaction(pool, async (client) => {
    if (reservation.source === 'free') {
      await repo.removeFreeUse(client, reservation.userId, reservation.month);
      return;
    }
    if (await repo.removeBundleUse(client, reservation.subscriptionId, reservation.periodStart)) {
      await repo.removeMonthlyTotal(client, reservation.userId, reservation.month);
    }
  });
}
