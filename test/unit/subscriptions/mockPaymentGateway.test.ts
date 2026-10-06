import { describe, expect, it } from 'vitest';

import { createMockPaymentGateway } from '../../../src/modules/subscriptions/infrastructure/mockPaymentGateway.js';

const request = (idempotencyKey: string) => ({
  subscriptionId: 'sub-1',
  userId: 'user-1',
  amountCents: 999,
  idempotencyKey,
});

describe('mock payment gateway', () => {
  it.each([
    [0, true],
    [1, false],
  ])('with failureRate %s, charges succeed: %s', async (failureRate, succeeded) => {
    const gateway = createMockPaymentGateway({ failureRate });
    expect(await gateway.charge(request('k1'))).toEqual({ succeeded });
  });

  it('decides with the injected random source', async () => {
    const draws = [0.9, 0.1];
    const gateway = createMockPaymentGateway({ failureRate: 0.5, random: () => draws.shift()! });

    expect(await gateway.charge(request('k1'))).toEqual({ succeeded: true });
    expect(await gateway.charge(request('k2'))).toEqual({ succeeded: false });
  });

  it('replays the original result for a repeated idempotency key without charging again', async () => {
    const draws = [0.1, 0.9];
    const gateway = createMockPaymentGateway({ failureRate: 0.5, random: () => draws.shift()! });

    const first = await gateway.charge(request('same-period'));
    const retry = await gateway.charge(request('same-period'));

    expect(retry).toEqual(first);
    expect(gateway.charges).toEqual([request('same-period')]);
  });
});
