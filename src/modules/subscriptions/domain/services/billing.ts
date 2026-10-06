import {
  expire,
  isRenewalDue,
  nextPeriodStart,
  renew,
  type Subscription,
} from '../entities/subscription.js';
import { addBillingCycle } from '../entities/period.js';
import type { PaymentGateway } from './paymentGateway.js';

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
      idempotencyKey: `${sub.id}:${periodStart.toISOString()}`,
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
