import { isAdmin, type Principal } from '../../../shared/auth/policy.js';
import { withTransaction } from '../../../shared/db/transaction.js';
import { AppError } from '../../../shared/errors.js';
import type { ChatMessage } from '../domain/entities/chatMessage.js';
import { assertCanListChats } from '../domain/policies/chatPolicy.js';
import { FREE_MESSAGES_PER_MONTH, monthStart, remaining } from '../domain/services/quota.js';
import * as chats from '../repositories/chatRepository.js';
import * as quota from '../repositories/quotaRepository.js';
import { askQuestion, type ChatDeps } from './askQuestion.js';
import { refundQuota } from './quota.js';

/**
 * Reserve quota, ask the AI (no transaction open), then store the chat in its own short
 * transaction. The chat row exists only for a successful answer that the client still
 * waits for; in every other case the reserved message is refunded.
 */
export async function postMessage(
  deps: ChatDeps,
  principal: Principal,
  input: { question: string; requestId: string; signal?: AbortSignal },
): Promise<ChatMessage> {
  const { reply, reservation } = await askQuestion(
    deps,
    principal.userId,
    input.question,
    input.signal,
  );

  // The request may have timed out just as the answer arrived: the client already got a 503.
  if (input.signal?.aborted) {
    await refundQuota(deps.pool, reservation);
    throw new AppError('unavailable', 'AI_TIMEOUT', 'The AI service took too long to answer');
  }

  try {
    return await withTransaction(deps.pool, (client) =>
      chats.insertMessage(client, {
        userId: principal.userId,
        question: input.question,
        answer: reply.answer,
        model: reply.model,
        promptTokens: reply.promptTokens,
        completionTokens: reply.completionTokens,
        totalTokens: reply.totalTokens,
        quotaSource: reservation.source,
        subscriptionId: reservation.source === 'subscription' ? reservation.subscriptionId : null,
        requestId: input.requestId,
        createdAt: deps.now(),
      }),
    );
  } catch (error) {
    await refundQuota(deps.pool, reservation);
    throw error;
  }
}

export async function listMessages(
  deps: ChatDeps,
  principal: Principal,
  query: { userId?: string; limit: number; offset: number },
): Promise<ChatMessage[]> {
  const page = { limit: query.limit, offset: query.offset };
  if (query.userId === undefined) {
    // Admins see all history by default; everyone else only their own.
    return chats.listMessages(deps.pool, isAdmin(principal) ? undefined : principal.userId, page);
  }
  assertCanListChats(principal, query.userId);
  return chats.listMessages(deps.pool, query.userId, page);
}

export interface Usage {
  month: string;
  free: { limit: number; used: number; remaining: number; resetsAt: Date };
  totalUsed: number;
  subscriptions: {
    id: string;
    tier: string;
    maxMessages: number | null;
    messagesUsed: number;
    /** null = unlimited */
    remaining: number | null;
    endDate: Date;
  }[];
}

export async function getUsage(deps: ChatDeps, principal: Principal): Promise<Usage> {
  const now = deps.now();
  const month = monthStart(now);
  const [usage, subs] = await Promise.all([
    quota.readMonthlyUsage(deps.pool, principal.userId, month),
    quota.listUsableSubscriptions(deps.pool, principal.userId, now),
  ]);

  return {
    month: month.toISOString().slice(0, 7),
    free: {
      limit: FREE_MESSAGES_PER_MONTH,
      used: usage.freeUsed,
      remaining: Math.max(0, FREE_MESSAGES_PER_MONTH - usage.freeUsed),
      resetsAt: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)),
    },
    totalUsed: usage.totalUsed,
    subscriptions: subs.map((sub) => ({
      id: sub.id,
      tier: sub.tier,
      maxMessages: sub.maxMessages,
      messagesUsed: sub.messagesUsed,
      remaining: sub.maxMessages === null ? null : Math.max(0, remaining(sub)),
      endDate: sub.endDate,
    })),
  };
}
