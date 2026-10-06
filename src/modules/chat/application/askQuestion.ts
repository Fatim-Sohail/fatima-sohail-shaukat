import type { Pool } from 'pg';

import { AppError } from '../../../shared/errors.js';
import type { AiAnswer, AiProvider } from '../domain/services/aiProvider.js';
import { refundQuota, reserveQuota, type Reservation } from './quota.js';

export interface ChatDeps {
  pool: Pool;
  ai: AiProvider;
  now: () => Date;
}

export interface AskResult {
  reply: AiAnswer;
  reservation: Reservation;
}

/**
 * Reserve quota, then call the AI with no transaction open, so slow answers never
 * hold locks or connections. If the AI fails, the reserved message is given back.
 */
export async function askQuestion(
  deps: ChatDeps,
  userId: string,
  question: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const reservation = await reserveQuota(deps.pool, userId, deps.now());

  try {
    const reply = await deps.ai.ask(question, signal);
    return { reply, reservation };
  } catch {
    await refundQuota(deps.pool, reservation);
    if (signal?.aborted) {
      throw new AppError('unavailable', 'AI_TIMEOUT', 'The AI service took too long to answer');
    }
    throw new AppError(
      'unavailable',
      'AI_UNAVAILABLE',
      'The AI service is unavailable, retry later',
    );
  }
}
