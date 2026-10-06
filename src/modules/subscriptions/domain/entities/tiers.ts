export type Tier = 'basic' | 'pro' | 'enterprise';
export type BillingCycle = 'monthly' | 'yearly';

export const TIERS = ['basic', 'pro', 'enterprise'] as const satisfies readonly Tier[];
export const BILLING_CYCLES = ['monthly', 'yearly'] as const satisfies readonly BillingCycle[];

interface Plan {
  /** null = unlimited */
  readonly maxMessages: number | null;
  readonly priceCents: Readonly<Record<BillingCycle, number>>;
}

// The only source of limits and prices: clients pick a tier name, never these values.
const PLANS: Readonly<Record<Tier, Plan>> = Object.freeze({
  basic: Object.freeze({
    maxMessages: 10,
    priceCents: Object.freeze({ monthly: 999, yearly: 9_990 }),
  }),
  pro: Object.freeze({
    maxMessages: 100,
    priceCents: Object.freeze({ monthly: 2_999, yearly: 29_990 }),
  }),
  enterprise: Object.freeze({
    maxMessages: null,
    priceCents: Object.freeze({ monthly: 9_999, yearly: 99_990 }),
  }),
});

export function planFor(tier: Tier): Plan {
  return PLANS[tier];
}
