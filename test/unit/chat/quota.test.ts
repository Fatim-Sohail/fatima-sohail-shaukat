import { describe, expect, it } from 'vitest';

import {
  decideQuota,
  monthStart,
  type Bundle,
} from '../../../src/modules/chat/domain/services/quota.js';

const NOW = new Date('2026-10-07T10:00:00.000Z');
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

function bundle(id: string, overrides: Partial<Bundle> = {}): Bundle {
  return {
    id,
    status: 'active',
    startDate: days(-10),
    endDate: days(20),
    maxMessages: 10,
    messagesUsed: 0,
    ...overrides,
  };
}

const decide = (freeUsed: number, bundles: Bundle[], now = NOW) =>
  decideQuota({ freeUsed, bundles, now });

const exhausted = expect.objectContaining({
  kind: 'payment_required',
  code: 'QUOTA_EXHAUSTED',
}) as Error;

describe('decideQuota', () => {
  it.each([0, 1, 2])('uses free quota while %s of 3 free messages are used', (freeUsed) => {
    expect(decide(freeUsed, [bundle('basic')])).toEqual({ source: 'free' });
  });

  it('moves to a subscription for the 4th message of the month', () => {
    expect(decide(3, [bundle('basic')])).toEqual({
      source: 'subscription',
      subscriptionId: 'basic',
    });
  });

  it('picks the bundle with the most messages left', () => {
    const bundles = [
      bundle('basic', { maxMessages: 10, messagesUsed: 2 }),
      bundle('pro', { maxMessages: 100, messagesUsed: 60 }),
      bundle('other-basic', { maxMessages: 10, messagesUsed: 0 }),
    ];
    expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'pro' });
  });

  it('breaks a tie on remaining messages with the newest start date', () => {
    const bundles = [
      bundle('older', { startDate: days(-20), messagesUsed: 5 }),
      bundle('newer', { startDate: days(-2), messagesUsed: 5 }),
    ];
    expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'newer' });
  });

  it('falls through to another bundle when the newest, largest one is used up', () => {
    const bundles = [
      bundle('pro-used-up', { startDate: days(-1), maxMessages: 100, messagesUsed: 100 }),
      bundle('basic', { startDate: days(-15), messagesUsed: 7 }),
    ];
    expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'basic' });
  });

  it('never selects a bundle with no messages left', () => {
    expect(() => decide(3, [bundle('used-up', { messagesUsed: 10 })])).toThrow(exhausted);
    expect(() => decide(3, [bundle('overused', { messagesUsed: 12 })])).toThrow(exhausted);
  });

  describe('Enterprise', () => {
    it('is unlimited however much it has been used', () => {
      const bundles = [
        bundle('pro', { maxMessages: 100, messagesUsed: 0 }),
        bundle('enterprise', { maxMessages: null, messagesUsed: 1_000_000 }),
      ];
      expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'enterprise' });
    });

    it('uses the newest of several unlimited bundles', () => {
      const bundles = [
        bundle('ent-old', { maxMessages: null, startDate: days(-20) }),
        bundle('ent-new', { maxMessages: null, startDate: days(-1) }),
      ];
      expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'ent-new' });
    });
  });

  describe('unusable bundles', () => {
    it('ignores inactive bundles', () => {
      const bundles = [
        bundle('inactive-pro', { status: 'inactive', maxMessages: 100 }),
        bundle('basic', { messagesUsed: 9 }),
      ];
      expect(decide(3, bundles)).toMatchObject({ subscriptionId: 'basic' });
      expect(() => decide(3, [bundle('inactive', { status: 'inactive' })])).toThrow(exhausted);
    });

    it.each([
      ['ended in the past', { endDate: days(-1) }],
      ['ending exactly now', { endDate: NOW }],
      ['not started yet', { startDate: days(1) }],
    ])('ignores a bundle %s', (_label, dates) => {
      const unlimited = bundle('ent', { maxMessages: null, ...dates });
      expect(() => decide(3, [unlimited])).toThrow(exhausted);
    });
  });

  it('reports QUOTA_EXHAUSTED with the free limit and when it resets', () => {
    expect(() => decide(3, [])).toThrow(
      expect.objectContaining({
        kind: 'payment_required',
        code: 'QUOTA_EXHAUSTED',
        details: { freeLimit: 3, freeResetsAt: '2026-11-01T00:00:00.000Z' },
      }) as Error,
    );
  });

  it('only decides: the bundles passed in are left untouched', () => {
    const bundles = [bundle('a', { messagesUsed: 3 }), bundle('b', { messagesUsed: 1 })];
    const snapshot = structuredClone(bundles);

    decide(3, bundles);
    expect(bundles).toEqual(snapshot);
  });
});

describe('monthly free quota reset', () => {
  it.each([
    ['the first instant of a month', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ['the last instant of a month', '2026-10-31T23:59:59.999Z', '2026-10-01T00:00:00.000Z'],
    ['December', '2026-12-15T08:00:00.000Z', '2026-12-01T00:00:00.000Z'],
  ])('keys usage by calendar month (UTC): %s', (_label, at, month) => {
    expect(monthStart(new Date(at))).toEqual(new Date(month));
  });

  it('gives a new month a fresh free quota, even after last month ran out', () => {
    const lastDayOfOctober = new Date('2026-10-31T23:59:00.000Z');
    const firstOfNovember = new Date('2026-11-01T00:00:00.000Z');

    // October's usage row is full; November has no usage row yet, so freeUsed is 0.
    expect(() => decide(3, [], lastDayOfOctober)).toThrow(exhausted);
    expect(monthStart(firstOfNovember)).not.toEqual(monthStart(lastDayOfOctober));
    expect(decide(0, [], firstOfNovember)).toEqual({ source: 'free' });
  });

  it('rolls the reset date over the year boundary', () => {
    expect(() => decide(3, [], new Date('2026-12-20T00:00:00.000Z'))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ freeResetsAt: '2027-01-01T00:00:00.000Z' }) as unknown,
      }) as Error,
    );
  });
});
