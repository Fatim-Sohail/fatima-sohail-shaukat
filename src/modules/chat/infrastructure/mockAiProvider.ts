import { setTimeout as sleep } from 'node:timers/promises';

import type { AiProvider } from '../domain/services/aiProvider.js';

export interface MockAiOptions {
  latencyMs: number;
  /** Probability in [0, 1] that a call fails. Defaults to 0. */
  failureRate?: number;
  random?: () => number;
}

export const MOCK_MODEL = 'mock-gpt-4o-mini';

// Roughly how OpenAI tokenizers average out for English text.
const tokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/** Stands in for the OpenAI API: simulated latency, deterministic answers, token counts. */
export function createMockAiProvider(options: MockAiOptions): AiProvider {
  const random = options.random ?? Math.random;
  const failureRate = options.failureRate ?? 0;

  return {
    async ask(question, signal) {
      await sleep(options.latencyMs, undefined, { signal });
      if (random() < failureRate) {
        throw new Error('mock AI provider failure');
      }

      // Deliberately does not echo the question back into the answer.
      const words = question.trim().split(/\s+/).length;
      const answer = `This is a simulated answer to your ${words}-word question.`;
      const promptTokens = tokens(question);
      const completionTokens = tokens(answer);
      return {
        answer,
        model: MOCK_MODEL,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };
    },
  };
}
