export type QuotaSource = 'free' | 'subscription';

export interface ChatMessage {
  id: string;
  userId: string;
  question: string;
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  quotaSource: QuotaSource;
  /** Set exactly when quotaSource is 'subscription'. */
  subscriptionId: string | null;
  requestId: string;
  createdAt: Date;
}

export const MAX_QUESTION_LENGTH = 2000;

/**
 * Questions are plain text. Tag-like markup is removed rather than escaped, so nothing
 * stored can be rendered as HTML later; a lone "<" as in "a < b" is kept. Control
 * characters are dropped except newlines and tabs.
 */
export function toPlainText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/<\/?[a-z][^<>]*>/gi, '')
    .replace(/\p{Cc}/gu, (char) => (char === '\n' || char === '\t' ? char : ''))
    .trim();
}
