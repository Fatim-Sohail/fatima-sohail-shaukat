import { describe, expect, it } from 'vitest';

import { cancel } from '../../../src/modules/subscriptions/domain/entities/subscription.js';
import { billSubscription } from '../../../src/modules/subscriptions/domain/services/billing.js';
import type {
  ChargeRequest,
  PaymentGateway,
} from '../../../src/modules/subscriptions/domain/services/paymentGateway.js';
import { daysAfter, subscription, T0 } from './fixtures.js';

const APRIL_15 = new Date('2026-04-15T12:00:00.000Z');
const MAY_15 = new Date('2026-05-15T12:00:00.000Z');

function gateway(succeeded: boolean): PaymentGateway & { charges: ChargeRequest[] } {
  const charges: ChargeRequest[] = [];
  return {
    charges,
    charge(request) {
      charges.push(request);
      return Promise.resolve({ succeeded });
    },
  };
}

describe('billSubscription', () => {
  it('charges and renews a due auto-renewing subscription', async () => {
    const payments = gateway(true);
    const sub = subscription({ tier: 'pro' }, { messagesUsed: 42 });

    const result = await billSubscription(sub, APRIL_15, payments);

    expect(result).toEqual({
      outcome: 'renewed',
      subscription: expect.objectContaining({
        status: 'active',
        startDate: APRIL_15,
        endDate: MAY_15,
        messagesUsed: 0,
      }) as unknown,
      payment: {
        amountCents: 2_999,
        status: 'succeeded',
        periodStart: APRIL_15,
        periodEnd: MAY_15,
      },
    });
    expect(payments.charges).toEqual([
      {
        subscriptionId: 'sub-1',
        userId: 'user-1',
        amountCents: 2_999,
        idempotencyKey: `sub-1:${APRIL_15.toISOString()}`,
      },
    ]);
  });

  it('deactivates the subscription when the payment fails', async () => {
    const result = await billSubscription(subscription(), APRIL_15, gateway(false));

    expect(result).toMatchObject({
      outcome: 'payment_failed',
      subscription: { status: 'inactive', autoRenew: false, renewalDate: null },
      payment: { status: 'failed', amountCents: 999 },
    });
  });

  it('uses the same idempotency key when the same period is billed again', async () => {
    const payments = gateway(false);
    await billSubscription(subscription(), APRIL_15, payments);
    await billSubscription(subscription(), daysAfter(APRIL_15, 1), payments);

    expect(new Set(payments.charges.map((charge) => charge.idempotencyKey)).size).toBe(1);
  });

  it('expires a subscription with auto-renew off once its period is over, without charging', async () => {
    const payments = gateway(true);
    const result = await billSubscription(subscription({ autoRenew: false }), APRIL_15, payments);

    expect(result).toMatchObject({ outcome: 'expired', subscription: { status: 'inactive' } });
    expect(payments.charges).toEqual([]);
  });

  it('never renews a cancelled subscription: it runs out its period, then expires', async () => {
    const payments = gateway(true);
    const cancelled = cancel(subscription(), daysAfter(T0, 3));

    const during = await billSubscription(cancelled, daysAfter(T0, 10), payments);
    const after = await billSubscription(cancelled, APRIL_15, payments);

    expect(during).toMatchObject({ outcome: 'unchanged', subscription: { status: 'active' } });
    expect(after).toMatchObject({ outcome: 'expired', subscription: { status: 'inactive' } });
    expect(payments.charges).toEqual([]);
  });

  it.each([
    ['not yet due', subscription(), daysAfter(T0, 10)],
    ['auto-renew off but still running', subscription({ autoRenew: false }), daysAfter(T0, 10)],
    ['already inactive', subscription({}, { status: 'inactive' }), MAY_15],
  ])('leaves a subscription that is %s unchanged and uncharged', async (_label, sub, now) => {
    const payments = gateway(true);

    expect(await billSubscription(sub, now, payments)).toEqual({
      outcome: 'unchanged',
      subscription: sub,
    });
    expect(payments.charges).toEqual([]);
  });
});
