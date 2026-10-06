import { describe, expect, it } from 'vitest';

import {
  assertAdmin,
  assertCanAccess,
  isAdmin,
  type Principal,
} from '../../../src/shared/auth/policy.js';

const principal = (userId: string, roles: string[] = ['user']): Principal => ({
  userId,
  issuer: 'https://idp.test',
  subject: `sub-${userId}`,
  roles,
});

describe('access policy', () => {
  const alice = principal('alice');
  const admin = principal('admin', ['user', 'admin']);

  it('recognizes admins only by the admin role', () => {
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(alice)).toBe(false);
    expect(isAdmin(principal('x', ['Admin', 'administrator']))).toBe(false);
  });

  it('lets owners and admins access a resource', () => {
    expect(() => {
      assertCanAccess(alice, 'alice');
    }).not.toThrow();
    expect(() => {
      assertCanAccess(admin, 'alice');
    }).not.toThrow();
  });

  it('hides other users’ resources behind not_found', () => {
    expect(() => {
      assertCanAccess(alice, 'bob');
    }).toThrow(expect.objectContaining({ kind: 'not_found', code: 'NOT_FOUND' }) as Error);
  });

  it('rejects non-admins from admin operations with forbidden', () => {
    expect(() => {
      assertAdmin(admin);
    }).not.toThrow();
    expect(() => {
      assertAdmin(alice);
    }).toThrow(expect.objectContaining({ kind: 'forbidden', code: 'FORBIDDEN' }) as Error);
  });
});
