import {
  assertAdmin,
  assertCanAccess,
  isAdmin,
  type Principal,
} from '../../../../shared/auth/policy.js';
import { AppError } from '../../../../shared/errors.js';
import type { Subscription } from '../entities/subscription.js';

type Owned = Pick<Subscription, 'userId'>;

/** Owner or admin. Anyone else gets not_found, so subscription IDs can't be probed. */
export function assertCanView(principal: Principal, sub: Owned): void {
  assertCanAccess(principal, sub.userId);
}

/** Only the owner can cancel or change a subscription; admins can see it but not act for the user. */
export function assertCanModify(principal: Principal, sub: Owned): void {
  if (principal.userId === sub.userId) {
    return;
  }
  if (isAdmin(principal)) {
    throw new AppError('forbidden', 'FORBIDDEN', 'Only the owner can change a subscription');
  }
  throw new AppError('not_found', 'NOT_FOUND', 'Resource not found');
}

/** Listing your own subscriptions is always allowed; anyone else's requires admin. */
export function assertCanList(principal: Principal, userId: string): void {
  if (principal.userId !== userId) {
    assertAdmin(principal);
  }
}
