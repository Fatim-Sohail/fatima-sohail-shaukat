import { assertAdmin, type Principal } from '../../../../shared/auth/policy.js';

/** Your own chat history is always readable; anyone else's requires admin. */
export function assertCanListChats(principal: Principal, userId: string): void {
  if (principal.userId !== userId) {
    assertAdmin(principal);
  }
}
