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
