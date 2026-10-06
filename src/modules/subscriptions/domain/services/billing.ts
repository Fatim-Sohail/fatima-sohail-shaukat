import {
  createSubscription,
  expire,
  isRenewalDue,
  nextPeriodStart,
  renew,
  type CreateSubscription,
  type Subscription,
} from '../entities/subscription.js';
import { addBillingCycle } from '../entities/period.js';
import type { PaymentGateway } from './paymentGateway.js';

// One key per subscription period, so a retried charge for the same period is deduplicated.
const chargeKey = (subscriptionId: string, periodStart: Date): string =>
  `${subscriptionId}:${periodStart.toISOString()}`;

export interface PaymentRecord {
  amountCents: number;
  status: 'succeeded' | 'failed';
  periodStart: Date;
  periodEnd: Date;
}

export type BillingResult =
  | { outcome: 'renewed'; subscription: Subscription; payment: PaymentRecord }
  | { outcome: 'payment_failed'; subscription: Subscription; payment: PaymentRecord }
  | { outcome: 'expired'; subscription: Subscription }
  | { outcome: 'unchanged'; subscription: Subscription };

/**
 * Decides what billing does to one subscription at `now`:
 * - auto-renew due: charge, then renew (success) or deactivate (failure)
 * - period over without auto-renew (incl. cancelled): deactivate, no charge
 * - otherwise: nothing
 */
export async function billSubscription(
  sub: Subscription,
  now: Date,
  payments: PaymentGateway,
): Promise<BillingResult> {
  if (sub.status === 'inactive') {
    return { outcome: 'unchanged', subscription: sub };
  }

  if (isRenewalDue(sub, now)) {
    const periodStart = nextPeriodStart(sub, now);
    const periodEnd = addBillingCycle(periodStart, sub.billingCycle);
    const { succeeded } = await payments.charge({
      subscriptionId: sub.id,
      userId: sub.userId,
      amountCents: sub.priceCents,
      idempotencyKey: chargeKey(sub.id, periodStart),
    });

    const payment: PaymentRecord = {
      amountCents: sub.priceCents,
      status: succeeded ? 'succeeded' : 'failed',
      periodStart,
      periodEnd,
    };
    return {
      outcome: succeeded ? 'renewed' : 'payment_failed',
      subscription: renew(sub, succeeded, now),
      payment,
    };
  }

  if (!sub.autoRenew && now >= sub.endDate) {
    return { outcome: 'expired', subscription: expire(sub, now) };
  }

  return { outcome: 'unchanged', subscription: sub };
}

/**
 * Initial purchase: charges the first period. A declined payment still yields a
 * record of the attempt, but the subscription is inactive and will never renew.
 */
export async function purchaseSubscription(
  input: CreateSubscription,
  id: string,
  now: Date,
  payments: PaymentGateway,
): Promise<{ subscription: Subscription; payment: PaymentRecord }> {
  const sub: Subscription = { id, ...createSubscription(input, now) };
  const { succeeded } = await payments.charge({
    subscriptionId: id,
    userId: sub.userId,
    amountCents: sub.priceCents,
    idempotencyKey: chargeKey(id, sub.startDate),
  });

  return {
    subscription: succeeded
      ? sub
      : { ...sub, status: 'inactive', autoRenew: false, renewalDate: null },
    payment: {
      amountCents: sub.priceCents,
      status: succeeded ? 'succeeded' : 'failed',
      periodStart: sub.startDate,
      periodEnd: sub.endDate,
    },
  };
}
