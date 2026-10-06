import { describe, expect, it } from 'vitest';

import {
  assertCanList,
  assertCanModify,
  assertCanView,
} from '../../../src/modules/subscriptions/domain/policies/subscriptionPolicy.js';
import type { Principal } from '../../../src/shared/auth/policy.js';

const principal = (userId: string, roles: string[] = ['user']): Principal => ({
  userId,
  issuer: 'https://idp.test',
  subject: userId,
  roles,
});

const owner = principal('owner');
const stranger = principal('stranger');
const admin = principal('admin', ['user', 'admin']);
const sub = { userId: 'owner' };

const denied = (kind: string) => expect.objectContaining({ kind }) as Error;

describe('subscription policy', () => {
  it('lets the owner view and change their subscription', () => {
    expect(() => {
      assertCanView(owner, sub);
    }).not.toThrow();
    expect(() => {
      assertCanModify(owner, sub);
    }).not.toThrow();
  });

  it('hides another user’s subscription as not_found', () => {
    expect(() => {
      assertCanView(stranger, sub);
    }).toThrow(denied('not_found'));
    expect(() => {
      assertCanModify(stranger, sub);
    }).toThrow(denied('not_found'));
  });

  it('lets an admin view any subscription but not change it for the user', () => {
    expect(() => {
      assertCanView(admin, sub);
    }).not.toThrow();
    expect(() => {
      assertCanModify(admin, sub);
    }).toThrow(denied('forbidden'));
  });

  it('allows listing your own subscriptions, and anyone else’s only as admin', () => {
    expect(() => {
      assertCanList(owner, 'owner');
    }).not.toThrow();
    expect(() => {
      assertCanList(stranger, 'owner');
    }).toThrow(denied('forbidden'));
    expect(() => {
      assertCanList(admin, 'owner');
    }).not.toThrow();
  });
});
