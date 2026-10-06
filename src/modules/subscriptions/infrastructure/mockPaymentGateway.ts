import { setTimeout as sleep } from 'node:timers/promises';

import type {
  ChargeRequest,
  ChargeResult,
  PaymentGateway,
} from '../domain/services/paymentGateway.js';

export interface MockPaymentOptions {
  /** Probability in [0, 1] that a charge is declined. 0 = always succeeds, 1 = always fails. */
  failureRate: number;
  random?: () => number;
  latencyMs?: number;
}

export interface MockPaymentGateway extends PaymentGateway {
  /** Charges actually executed (idempotent replays are not repeated here). */
  readonly charges: readonly ChargeRequest[];
}

/**
 * Simulated payment provider. Like a real one, it remembers idempotency keys: a repeated
 * key returns the original result without charging again.
 */
export function createMockPaymentGateway(options: MockPaymentOptions): MockPaymentGateway {
  const random = options.random ?? Math.random;
  const results = new Map<string, ChargeResult>();
  const charges: ChargeRequest[] = [];

  return {
    charges,
    async charge(request) {
      if (options.latencyMs) {
        await sleep(options.latencyMs);
      }
      const previous = results.get(request.idempotencyKey);
      if (previous) {
        return previous;
      }
      const result = { succeeded: random() >= options.failureRate };
      results.set(request.idempotencyKey, result);
      charges.push(request);
      return result;
    },
  };
}
