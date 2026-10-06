import { AppError } from '../errors.js';

export type Role = 'user' | 'admin';

/** Identity of an authenticated caller. Built only from a verified token and the local user row. */
export interface Principal {
  userId: string;
  issuer: string;
  subject: string;
  roles: readonly string[];
}

export function isAdmin(principal: Principal): boolean {
  return principal.roles.includes('admin');
}

/** Owners and admins only. Everyone else gets a 404 so resource IDs can't be probed. */
export function assertCanAccess(principal: Principal, ownerId: string): void {
  if (principal.userId !== ownerId && !isAdmin(principal)) {
    throw new AppError('not_found', 'NOT_FOUND', 'Resource not found');
  }
}

export function assertAdmin(principal: Principal): void {
  if (!isAdmin(principal)) {
    throw new AppError('forbidden', 'FORBIDDEN', 'Insufficient permissions');
  }
}
