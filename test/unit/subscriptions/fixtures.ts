import {
  createSubscription,
  type CreateSubscription,
  type Subscription,
} from '../../../src/modules/subscriptions/domain/entities/subscription.js';

export const T0 = new Date('2026-03-15T12:00:00.000Z');

export const daysAfter = (date: Date, days: number): Date =>
  new Date(date.getTime() + days * 86_400_000);

/** An active Basic monthly subscription created at T0, with auto-renew on. */
export function subscription(
  input: Partial<CreateSubscription> = {},
  overrides: Partial<Subscription> = {},
): Subscription {
  const created = createSubscription(
    { userId: 'user-1', tier: 'basic', billingCycle: 'monthly', autoRenew: true, ...input },
    T0,
  );
  return { id: 'sub-1', ...created, ...overrides };
}
