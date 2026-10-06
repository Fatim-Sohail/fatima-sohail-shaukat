import type { Pool, PoolClient } from 'pg';

import type { ChatMessage } from '../domain/entities/chatMessage.js';

type Db = Pool | PoolClient;

interface Row {
  id: string;
  user_id: string;
  question: string;
  answer: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  quota_source: ChatMessage['quotaSource'];
  subscription_id: string | null;
  request_id: string;
  created_at: Date;
}

const COLUMNS = `id, user_id, question, answer, model, prompt_tokens, completion_tokens,
  total_tokens, quota_source, subscription_id, request_id, created_at`;

function toMessage(row: Row): ChatMessage {
  return {
    id: row.id,
    userId: row.user_id,
    question: row.question,
    answer: row.answer,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    quotaSource: row.quota_source,
    subscriptionId: row.subscription_id,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export async function insertMessage(
  db: Db,
  message: Omit<ChatMessage, 'id'>,
): Promise<ChatMessage> {
  const { rows } = await db.query<Row>(
    `INSERT INTO chat_messages (user_id, question, answer, model, prompt_tokens,
       completion_tokens, total_tokens, quota_source, subscription_id, request_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      message.userId,
      message.question,
      message.answer,
      message.model,
      message.promptTokens,
      message.completionTokens,
      message.totalTokens,
      message.quotaSource,
      message.subscriptionId,
      message.requestId,
      message.createdAt,
    ],
  );
  const [row] = rows;
  if (!row) {
    throw new Error('chat insert returned no row');
  }
  return toMessage(row);
}

/** Newest first. Without a userId, lists every user's messages (admin view). */
export async function listMessages(
  db: Db,
  userId: string | undefined,
  page: { limit: number; offset: number },
): Promise<ChatMessage[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLUMNS} FROM chat_messages
     WHERE $1::uuid IS NULL OR user_id = $1
     ORDER BY created_at DESC, id
     LIMIT $2 OFFSET $3`,
    [userId ?? null, page.limit, page.offset],
  );
  return rows.map(toMessage);
}
