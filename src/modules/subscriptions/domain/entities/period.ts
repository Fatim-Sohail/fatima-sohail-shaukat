import type { BillingCycle } from './tiers.js';

/**
 * End of a billing period that starts at `start` (UTC). Month-end dates clamp to
 * the last day of the target month: Jan 31 + 1 month = Feb 28/29, not Mar 3.
 */
export function addBillingCycle(start: Date, cycle: BillingCycle): Date {
  const months = cycle === 'monthly' ? 1 : 12;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(start.getUTCDate(), lastDayOfTarget),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}
