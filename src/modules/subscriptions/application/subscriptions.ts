import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { isAdmin, type Principal } from '../../../shared/auth/policy.js';
import { withTransaction } from '../../../shared/db/transaction.js';
import { AppError } from '../../../shared/errors.js';
import { cancel, setAutoRenew, type Subscription } from '../domain/entities/subscription.js';
import type { BillingCycle, Tier } from '../domain/entities/tiers.js';
import {
  assertCanList,
  assertCanModify,
  assertCanView,
} from '../domain/policies/subscriptionPolicy.js';
import { purchaseSubscription } from '../domain/services/billing.js';
import type { PaymentGateway } from '../domain/services/paymentGateway.js';
import * as repo from '../repositories/subscriptionRepository.js';

export interface SubscriptionDeps {
  pool: Pool;
  payments: PaymentGateway;
  now: () => Date;
}

const notFound = (): AppError => new AppError('not_found', 'NOT_FOUND', 'Resource not found');

export async function subscribe(
  deps: SubscriptionDeps,
  principal: Principal,
  input: { tier: Tier; billingCycle: BillingCycle; autoRenew: boolean },
): Promise<Subscription> {
  const id = randomUUID();

  // Charged before the transaction so no DB connection is held while the provider responds.
  let result: Awaited<ReturnType<typeof purchaseSubscription>>;
  try {
    result = await purchaseSubscription(
      {
        userId: principal.userId,
        tier: input.tier,
        billingCycle: input.billingCycle,
        autoRenew: input.autoRenew,
      },
      id,
      deps.now(),
      deps.payments,
    );
  } catch {
    throw new AppError(
      'unavailable',
      'PAYMENT_UNAVAILABLE',
      'Payment provider unavailable, retry later',
    );
  }

  await withTransaction(deps.pool, async (client) => {
    await repo.insertSubscription(client, result.subscription);
    await repo.insertPayment(client, id, result.payment);
  });

  if (result.payment.status === 'failed') {
    throw new AppError('payment_required', 'PAYMENT_FAILED', 'Payment was declined', {
      subscriptionId: id,
    });
  }
  return result.subscription;
}

export async function listSubscriptions(
  deps: SubscriptionDeps,
  principal: Principal,
  query: { userId?: string; limit: number; offset: number },
): Promise<Subscription[]> {
  const page = { limit: query.limit, offset: query.offset };
  if (query.userId === undefined) {
    // Admins see everything by default; everyone else only their own.
    const scope = isAdmin(principal) ? undefined : principal.userId;
    return repo.listSubscriptions(deps.pool, scope, page);
  }
  assertCanList(principal, query.userId);
  return repo.listSubscriptions(deps.pool, query.userId, page);
}

export async function getSubscription(
  deps: SubscriptionDeps,
  principal: Principal,
  id: string,
): Promise<Subscription> {
  const sub = await repo.findSubscription(deps.pool, id);
  if (!sub) {
    throw notFound();
  }
  assertCanView(principal, sub);
  return sub;
}

/** Locks the row, checks ownership, applies a domain transition and writes it back. */
function modify(
  deps: SubscriptionDeps,
  principal: Principal,
  id: string,
  change: (sub: Subscription) => Subscription,
): Promise<Subscription> {
  return withTransaction(deps.pool, async (client) => {
    const sub = await repo.findForUpdate(client, id);
    if (!sub) {
      throw notFound();
    }
    assertCanModify(principal, sub);

    const updated = change(sub);
    if (updated !== sub) {
      await repo.updateSubscription(client, updated);
    }
    return updated;
  });
}

export function changeAutoRenew(
  deps: SubscriptionDeps,
  principal: Principal,
  id: string,
  autoRenew: boolean,
): Promise<Subscription> {
  return modify(deps, principal, id, (sub) => setAutoRenew(sub, autoRenew));
}

export function cancelSubscription(
  deps: SubscriptionDeps,
  principal: Principal,
  id: string,
): Promise<Subscription> {
  return modify(deps, principal, id, (sub) => cancel(sub, deps.now()));
}
