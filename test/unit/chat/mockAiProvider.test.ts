import { describe, expect, it } from 'vitest';

import {
  createMockAiProvider,
  MOCK_MODEL,
} from '../../../src/modules/chat/infrastructure/mockAiProvider.js';

describe('mock AI provider', () => {
  it('answers deterministically with consistent token counts', async () => {
    const ai = createMockAiProvider({ latencyMs: 0 });

    const first = await ai.ask('How do refunds work?');
    const second = await ai.ask('How do refunds work?');

    expect(first).toEqual(second);
    expect(first).toEqual({
      answer: 'This is a simulated answer to your 4-word question.',
      model: MOCK_MODEL,
      promptTokens: 5,
      completionTokens: 13,
      totalTokens: 18,
    });
  });

  it('does not echo the question into the answer', async () => {
    const ai = createMockAiProvider({ latencyMs: 0 });
    const { answer } = await ai.ask('<script>alert(1)</script>');

    expect(answer).not.toContain('<script>');
  });

  it('waits for the configured latency', async () => {
    const ai = createMockAiProvider({ latencyMs: 50 });
    const started = Date.now();

    await ai.ask('Hi');
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('stops waiting as soon as the signal aborts', async () => {
    const ai = createMockAiProvider({ latencyMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => {
      controller.abort();
    }, 20);

    await expect(ai.ask('Hi', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('fails as configured by failureRate and the injected random source', async () => {
    const draws = [0.1, 0.9];
    const ai = createMockAiProvider({
      latencyMs: 0,
      failureRate: 0.5,
      random: () => draws.shift()!,
    });

    await expect(ai.ask('Hi')).rejects.toThrow('mock AI provider failure');
    await expect(ai.ask('Hi')).resolves.toBeDefined();
  });
});
