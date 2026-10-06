import { describe, expect, it } from 'vitest';

import {
  cancel,
  createSubscription,
  expire,
  isUsable,
  renew,
  setAutoRenew,
  type CreateSubscription,
} from '../../../src/modules/subscriptions/domain/entities/subscription.js';
import { daysAfter, subscription, T0 } from './fixtures.js';

const APRIL_15 = new Date('2026-04-15T12:00:00.000Z');
const MAY_15 = new Date('2026-05-15T12:00:00.000Z');

function conflict(code: string) {
  return expect.objectContaining({ kind: 'conflict', code }) as Error;
}

describe('createSubscription', () => {
  it('starts an active period priced and limited by the tier catalog', () => {
    expect(
      createSubscription(
        { userId: 'user-1', tier: 'basic', billingCycle: 'monthly', autoRenew: true },
        T0,
      ),
    ).toEqual({
      userId: 'user-1',
      tier: 'basic',
      billingCycle: 'monthly',
      maxMessages: 10,
      messagesUsed: 0,
      priceCents: 999,
      autoRenew: true,
      status: 'active',
      startDate: T0,
      endDate: APRIL_15,
      renewalDate: APRIL_15,
      cancelledAt: null,
    });
  });

  it('leaves renewalDate empty when auto-renew is off', () => {
    expect(subscription({ autoRenew: false }).renewalDate).toBeNull();
  });

  it('creates an unlimited yearly enterprise subscription', () => {
    const sub = subscription({ tier: 'enterprise', billingCycle: 'yearly' });

    expect(sub).toMatchObject({ maxMessages: null, priceCents: 99_990 });
    expect(sub.endDate).toEqual(new Date('2027-03-15T12:00:00.000Z'));
  });

  it('ignores limits, price or state smuggled into the input', () => {
    const input = {
      userId: 'user-1',
      tier: 'pro',
      billingCycle: 'monthly',
      autoRenew: false,
      maxMessages: 1_000_000,
      priceCents: 0,
      status: 'inactive',
      messagesUsed: -50,
    } as CreateSubscription;

    expect(createSubscription(input, T0)).toMatchObject({
      maxMessages: 100,
      priceCents: 2_999,
      status: 'active',
      messagesUsed: 0,
    });
  });
});

describe('isUsable', () => {
  const sub = subscription();

  it('is usable from startDate until just before endDate', () => {
    expect(isUsable(sub, T0)).toBe(true);
    expect(isUsable(sub, new Date(APRIL_15.getTime() - 1))).toBe(true);
  });

  it('is not usable before it starts or from endDate on', () => {
    expect(isUsable(sub, new Date(T0.getTime() - 1))).toBe(false);
    expect(isUsable(sub, APRIL_15)).toBe(false);
  });

  it('is never usable when inactive', () => {
    expect(isUsable({ ...sub, status: 'inactive' }, daysAfter(T0, 1))).toBe(false);
  });
});

describe('cancel', () => {
  it('stops renewal but keeps the current period usable', () => {
    const now = daysAfter(T0, 5);
    const cancelled = cancel(subscription(), now);

    expect(cancelled).toMatchObject({
      status: 'active',
      cancelledAt: now,
      autoRenew: false,
      renewalDate: null,
      endDate: APRIL_15,
    });
    expect(isUsable(cancelled, daysAfter(T0, 20))).toBe(true);
    expect(isUsable(cancelled, APRIL_15)).toBe(false);
  });

  it('is idempotent: cancelling again changes nothing', () => {
    const once = cancel(subscription(), daysAfter(T0, 1));
    expect(cancel(once, daysAfter(T0, 9))).toBe(once);
  });

  it('rejects cancelling a subscription that is already inactive', () => {
    expect(() => cancel(subscription({}, { status: 'inactive' }), T0)).toThrow(
      conflict('SUBSCRIPTION_INACTIVE'),
    );
  });

  it('does not mutate the original', () => {
    const sub = subscription();
    cancel(sub, T0);
    expect(sub.cancelledAt).toBeNull();
  });
});

describe('setAutoRenew', () => {
  it('clears renewalDate when turned off and sets it to endDate when turned on', () => {
    const off = setAutoRenew(subscription(), false);
    const on = setAutoRenew(off, true);

    expect(off).toMatchObject({ autoRenew: false, renewalDate: null });
    expect(on).toMatchObject({ autoRenew: true, renewalDate: APRIL_15 });
  });

  it('refuses to turn auto-renew back on for a cancelled subscription', () => {
    const cancelled = cancel(subscription(), T0);

    expect(() => setAutoRenew(cancelled, true)).toThrow(conflict('SUBSCRIPTION_CANCELLED'));
    expect(setAutoRenew(cancelled, false)).toBe(cancelled);
  });

  it('refuses changes on an inactive subscription', () => {
    expect(() => setAutoRenew(subscription({}, { status: 'inactive' }), true)).toThrow(
      conflict('SUBSCRIPTION_INACTIVE'),
    );
  });
});

describe('renew', () => {
  it('starts the next period at the old end date and resets usage', () => {
    const renewed = renew(subscription({}, { messagesUsed: 7 }), true, APRIL_15);

    expect(renewed).toMatchObject({
      status: 'active',
      startDate: APRIL_15,
      endDate: MAY_15,
      renewalDate: MAY_15,
      messagesUsed: 0,
    });
    expect(isUsable(renewed, APRIL_15)).toBe(true);
  });

  it('starts the new period now if renewal ran more than a full period late', () => {
    const late = daysAfter(APRIL_15, 45);
    const renewed = renew(subscription(), true, late);

    expect(renewed.startDate).toEqual(late);
    expect(isUsable(renewed, late)).toBe(true);
  });

  it('deactivates the subscription when payment fails, keeping its usage history', () => {
    const failed = renew(subscription({}, { messagesUsed: 7 }), false, APRIL_15);

    expect(failed).toMatchObject({
      status: 'inactive',
      autoRenew: false,
      renewalDate: null,
      messagesUsed: 7,
      endDate: APRIL_15,
    });
    expect(isUsable(failed, APRIL_15)).toBe(false);
  });
});

describe('invalid transitions', () => {
  it.each([
    ['before the renewal date', subscription(), daysAfter(T0, 1)],
    ['with auto-renew off', subscription({ autoRenew: false }), APRIL_15],
    ['after cancellation', cancel(subscription(), T0), APRIL_15],
    ['when inactive', subscription({}, { status: 'inactive' }), APRIL_15],
  ])('renew is rejected %s', (_label, sub, now) => {
    expect(() => renew(sub, true, now)).toThrow(conflict('RENEWAL_NOT_DUE'));
  });

  it('expire is rejected while the period is still running', () => {
    expect(() => expire(subscription({ autoRenew: false }), daysAfter(T0, 1))).toThrow(
      conflict('PERIOD_NOT_OVER'),
    );
  });

  it('expire is rejected for a subscription that is set to renew', () => {
    expect(() => expire(subscription(), APRIL_15)).toThrow(conflict('RENEWAL_PENDING'));
  });

  it('expire ends a finished, non-renewing subscription and is idempotent', () => {
    const expired = expire(subscription({ autoRenew: false }), APRIL_15);

    expect(expired).toMatchObject({ status: 'inactive', renewalDate: null });
    expect(expire(expired, MAY_15)).toBe(expired);
  });

  it('reports domain errors without HTTP status codes', () => {
    try {
      renew(subscription(), true, T0);
      expect.unreachable();
    } catch (error) {
      expect(error).not.toHaveProperty('statusCode');
      expect(error).toMatchObject({ kind: 'conflict' });
    }
  });
});
