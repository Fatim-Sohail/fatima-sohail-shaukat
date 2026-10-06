export interface AiAnswer {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiProvider {
  /** Rejects if the provider fails or `signal` aborts. */
  ask(question: string, signal?: AbortSignal): Promise<AiAnswer>;
}
