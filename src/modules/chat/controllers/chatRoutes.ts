import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { principalOf } from '../../../shared/http/auth.js';
import type { ChatDeps } from '../application/askQuestion.js';
import { getUsage, listMessages, postMessage } from '../application/chat.js';
import {
  MAX_QUESTION_LENGTH,
  toPlainText,
  type ChatMessage,
} from '../domain/entities/chatMessage.js';

const postBody = z.strictObject({
  question: z
    .string()
    .max(MAX_QUESTION_LENGTH)
    .transform(toPlainText)
    .pipe(z.string().min(1, 'Question is empty once markup is removed')),
});

const listQuery = z.strictObject({
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const noQuery = z.strictObject({});

function present(message: ChatMessage) {
  return {
    id: message.id,
    userId: message.userId,
    question: message.question,
    answer: message.answer,
    tokens: {
      prompt: message.promptTokens,
      completion: message.completionTokens,
      total: message.totalTokens,
    },
    quotaSource: message.quotaSource,
    subscriptionId: message.subscriptionId,
    requestId: message.requestId,
    createdAt: message.createdAt,
  };
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatDeps): void {
  const config = { rateLimitGroup: 'chat' } as const;

  app.post('/chat/messages', { config }, async (request, reply) => {
    const { question } = postBody.parse(request.body);
    const message = await postMessage(deps, principalOf(request), {
      question,
      requestId: request.id,
      // Aborted on request timeout or client disconnect; cancels the AI call.
      ...(request.abortSignal ? { signal: request.abortSignal } : {}),
    });
    return reply.status(201).send(present(message));
  });

  app.get('/chat/messages', { config }, async (request) => {
    const query = listQuery.parse(request.query);
    const messages = await listMessages(deps, principalOf(request), query);
    return { items: messages.map(present) };
  });

  app.get('/chat/usage', { config }, async (request) => {
    noQuery.parse(request.query);
    return getUsage(deps, principalOf(request));
  });
}
