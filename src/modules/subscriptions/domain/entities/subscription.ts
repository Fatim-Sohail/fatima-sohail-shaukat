import { AppError } from '../../../../shared/errors.js';
import { addBillingCycle } from './period.js';
import { planFor, type BillingCycle, type Tier } from './tiers.js';

export type SubscriptionStatus = 'active' | 'inactive';

export interface Subscription {
  id: string;
  userId: string;
  tier: Tier;
  billingCycle: BillingCycle;
  /** null = unlimited */
  maxMessages: number | null;
  messagesUsed: number;
  priceCents: number;
  autoRenew: boolean;
  status: SubscriptionStatus;
  startDate: Date;
  endDate: Date;
  /** Set exactly when auto-renew is on. */
  renewalDate: Date | null;
  cancelledAt: Date | null;
}

/** A subscription before it has been stored and given an id. */
export type NewSubscription = Omit<Subscription, 'id'>;

export interface CreateSubscription {
  userId: string;
  tier: Tier;
  billingCycle: BillingCycle;
  autoRenew: boolean;
}

const conflict = (code: string, message: string): AppError =>
  new AppError('conflict', code, message);

export function createSubscription(input: CreateSubscription, now: Date): NewSubscription {
  // Limits and price come from the catalog only, never from the input.
  const plan = planFor(input.tier);
  const endDate = addBillingCycle(now, input.billingCycle);
  return {
    userId: input.userId,
    tier: input.tier,
    billingCycle: input.billingCycle,
    maxMessages: plan.maxMessages,
    messagesUsed: 0,
    priceCents: plan.priceCents[input.billingCycle],
    autoRenew: input.autoRenew,
    status: 'active',
    startDate: now,
    endDate,
    renewalDate: input.autoRenew ? endDate : null,
    cancelledAt: null,
  };
}

export function isUsable(sub: NewSubscription, now: Date): boolean {
  return sub.status === 'active' && sub.startDate <= now && now < sub.endDate;
}

export function isRenewalDue(sub: NewSubscription, now: Date): boolean {
  return (
    sub.status === 'active' && sub.autoRenew && sub.renewalDate !== null && sub.renewalDate <= now
  );
}

/**
 * Start of the period that follows the current one. Normally the old end date, so the
 * billing anchor is kept; if renewal ran so late that a whole period was missed, the
 * new period starts now instead of lying entirely in the past.
 */
export function nextPeriodStart(sub: NewSubscription, now: Date): Date {
  return addBillingCycle(sub.endDate, sub.billingCycle) > now ? sub.endDate : now;
}

/**
 * Stops future renewals; the current period stays usable until endDate.
 * Idempotent: cancelling an already-cancelled subscription returns it unchanged.
 */
export function cancel<T extends NewSubscription>(sub: T, now: Date): T {
  if (sub.cancelledAt !== null) {
    return sub;
  }
  if (sub.status === 'inactive') {
    throw conflict('SUBSCRIPTION_INACTIVE', 'Subscription is no longer active');
  }
  return { ...sub, cancelledAt: now, autoRenew: false, renewalDate: null };
}

export function setAutoRenew<T extends NewSubscription>(sub: T, enabled: boolean): T {
  if (sub.status === 'inactive') {
    throw conflict('SUBSCRIPTION_INACTIVE', 'Subscription is no longer active');
  }
  if (sub.cancelledAt !== null) {
    if (enabled) {
      throw conflict('SUBSCRIPTION_CANCELLED', 'A cancelled subscription cannot be renewed');
    }
    return sub;
  }
  return { ...sub, autoRenew: enabled, renewalDate: enabled ? sub.endDate : null };
}

/** Applies a renewal attempt. A failed payment ends the subscription; no retries. */
export function renew<T extends NewSubscription>(sub: T, paymentSucceeded: boolean, now: Date): T {
  if (!isRenewalDue(sub, now)) {
    throw conflict('RENEWAL_NOT_DUE', 'Subscription is not due for renewal');
  }
  if (!paymentSucceeded) {
    return { ...sub, status: 'inactive', autoRenew: false, renewalDate: null };
  }

  const startDate = nextPeriodStart(sub, now);
  const endDate = addBillingCycle(startDate, sub.billingCycle);
  return { ...sub, startDate, endDate, renewalDate: endDate, messagesUsed: 0 };
}

/** Ends a subscription whose period is over and which will not renew. */
export function expire<T extends NewSubscription>(sub: T, now: Date): T {
  if (sub.status === 'inactive') {
    return sub;
  }
  if (now < sub.endDate) {
    throw conflict('PERIOD_NOT_OVER', 'Subscription period has not ended');
  }
  if (sub.autoRenew) {
    throw conflict('RENEWAL_PENDING', 'Subscription is set to renew');
  }
  return { ...sub, status: 'inactive', renewalDate: null };
}
