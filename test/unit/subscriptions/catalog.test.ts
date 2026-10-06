import { describe, expect, it } from 'vitest';

import { addBillingCycle } from '../../../src/modules/subscriptions/domain/entities/period.js';
import { planFor, TIERS } from '../../../src/modules/subscriptions/domain/entities/tiers.js';

describe('tier catalog', () => {
  it.each([
    ['basic', 10],
    ['pro', 100],
    ['enterprise', null],
  ] as const)('%s allows %s messages (null = unlimited)', (tier, maxMessages) => {
    expect(planFor(tier).maxMessages).toBe(maxMessages);
  });

  it('prices every tier for both billing cycles on the server side', () => {
    expect(TIERS.map((tier) => planFor(tier).priceCents)).toEqual([
      { monthly: 999, yearly: 9_990 },
      { monthly: 2_999, yearly: 29_990 },
      { monthly: 9_999, yearly: 99_990 },
    ]);
  });

  it('cannot be modified at runtime', () => {
    const plan = planFor('basic') as { maxMessages: number | null };

    expect(() => {
      plan.maxMessages = 1_000_000;
    }).toThrow(TypeError);
    expect(planFor('basic').maxMessages).toBe(10);
  });
});

describe('addBillingCycle', () => {
  const at = (iso: string) => new Date(iso);

  it.each([
    ['monthly', '2026-03-15T12:30:45.123Z', '2026-04-15T12:30:45.123Z'],
    ['monthly', '2026-12-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z'],
    ['yearly', '2026-03-15T12:30:45.123Z', '2027-03-15T12:30:45.123Z'],
  ] as const)('adds one %s period: %s -> %s', (cycle, start, end) => {
    expect(addBillingCycle(at(start), cycle)).toEqual(at(end));
  });

  it.each([
    ['Jan 31 to Feb 28 in a common year', '2026-01-31T09:00:00.000Z', '2026-02-28T09:00:00.000Z'],
    ['Jan 31 to Feb 29 in a leap year', '2028-01-31T09:00:00.000Z', '2028-02-29T09:00:00.000Z'],
    ['Mar 31 to Apr 30', '2026-03-31T09:00:00.000Z', '2026-04-30T09:00:00.000Z'],
    ['Dec 31 to Jan 31', '2026-12-31T09:00:00.000Z', '2027-01-31T09:00:00.000Z'],
  ])('clamps month-end dates monthly: %s', (_label, start, end) => {
    expect(addBillingCycle(at(start), 'monthly')).toEqual(at(end));
  });

  it('clamps Feb 29 to Feb 28 for a yearly period', () => {
    expect(addBillingCycle(at('2028-02-29T09:00:00.000Z'), 'yearly')).toEqual(
      at('2029-02-28T09:00:00.000Z'),
    );
  });

  it('does not mutate the start date', () => {
    const start = at('2026-01-31T09:00:00.000Z');
    addBillingCycle(start, 'monthly');
    expect(start).toEqual(at('2026-01-31T09:00:00.000Z'));
  });
});
