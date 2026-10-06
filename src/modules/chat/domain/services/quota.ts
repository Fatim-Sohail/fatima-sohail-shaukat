import {
  isUsable,
  type Subscription,
} from '../../../subscriptions/domain/entities/subscription.js';
import { AppError } from '../../../../shared/errors.js';

export const FREE_MESSAGES_PER_MONTH = 3;

/** The subscription fields quota needs. maxMessages null = unlimited (Enterprise). */
export type Bundle = Pick<
  Subscription,
  'id' | 'status' | 'startDate' | 'endDate' | 'maxMessages' | 'messagesUsed'
>;

export type QuotaDecision = { source: 'free' } | { source: 'subscription'; subscriptionId: string };

/**
 * Free usage is tracked per calendar month (UTC). Storing it keyed by this date is what
 * resets it: a new month has no usage yet, so it starts again from 0.
 */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function remaining(bundle: Bundle): number {
  return bundle.maxMessages === null ? Infinity : bundle.maxMessages - bundle.messagesUsed;
}

/**
 * Decides where the next message is paid from, without deducting anything:
 * free quota first, then the usable bundle with the most messages left
 * (newest start date on a tie).
 */
export function decideQuota(input: {
  freeUsed: number;
  bundles: readonly Bundle[];
  now: Date;
}): QuotaDecision {
  if (input.freeUsed < FREE_MESSAGES_PER_MONTH) {
    return { source: 'free' };
  }

  const [best] = input.bundles
    .filter((bundle) => isUsable(bundle, input.now) && remaining(bundle) > 0)
    .sort(
      (a, b) =>
        remaining(b) - remaining(a) ||
        b.startDate.getTime() - a.startDate.getTime() ||
        a.id.localeCompare(b.id),
    );

  if (!best) {
    throw new AppError(
      'payment_required',
      'QUOTA_EXHAUSTED',
      'No messages left: the monthly free quota is used up and no subscription has quota',
      {
        freeLimit: FREE_MESSAGES_PER_MONTH,
        freeResetsAt: nextMonthStart(input.now).toISOString(),
      },
    );
  }
  return { source: 'subscription', subscriptionId: best.id };
}
