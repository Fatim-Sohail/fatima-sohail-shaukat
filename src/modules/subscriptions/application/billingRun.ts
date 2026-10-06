import { assertAdmin, type Principal } from '../../../shared/auth/policy.js';
import { withTransaction } from '../../../shared/db/transaction.js';
import { billSubscription, type BillingResult } from '../domain/services/billing.js';
import * as repo from '../repositories/subscriptionRepository.js';
import type { SubscriptionDeps } from './subscriptions.js';

export interface BillingSummary {
  renewed: number;
  failed: number;
  expired: number;
  errors: number;
}

/** Admin-triggered billing (POST /admin/billing/run). */
export function runBilling(deps: SubscriptionDeps, principal: Principal): Promise<BillingSummary> {
  assertAdmin(principal);
  return billDueSubscriptions(deps);
}

/**
 * Processes every subscription that is due, one per transaction. The row stays locked
 * while it is charged so no other run can bill it concurrently; the charge's idempotency
 * key covers a crash between charging and committing. Shared by the admin endpoint and
 * the scheduler, which has no user principal.
 */
export async function billDueSubscriptions(deps: SubscriptionDeps): Promise<BillingSummary> {
  const now = deps.now();
  const summary: BillingSummary = { renewed: 0, failed: 0, expired: 0, errors: 0 };
  // Rows already tried in this run; a row that errored stays due and must not be retried in a loop.
  const attempted: string[] = [];

  for (;;) {
    let lockedId: string | undefined;
    let result: BillingResult | null;
    try {
      result = await withTransaction(deps.pool, async (client) => {
        const sub = await repo.lockNextDue(client, now, attempted);
        if (!sub) {
          return null;
        }
        lockedId = sub.id;

        const billed = await billSubscription(sub, now, deps.payments);
        if (billed.outcome !== 'unchanged') {
          await repo.updateSubscription(client, billed.subscription);
        }
        if ('payment' in billed) {
          await repo.insertPayment(client, sub.id, billed.payment);
        }
        return billed;
      });
    } catch (error) {
      if (lockedId === undefined) {
        throw error;
      }
      attempted.push(lockedId);
      summary.errors++;
      continue;
    }

    if (!result) {
      return summary;
    }
    attempted.push(result.subscription.id);
    if (result.outcome === 'renewed') {
      summary.renewed++;
    } else if (result.outcome === 'payment_failed') {
      summary.failed++;
    } else if (result.outcome === 'expired') {
      summary.expired++;
    }
  }
}
