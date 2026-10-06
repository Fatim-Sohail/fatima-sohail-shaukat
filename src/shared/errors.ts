/**
 * Category of an expected failure. Deliberately transport-agnostic: domain and
 * application code describe *what* went wrong and the HTTP layer maps it to a status.
 */
export type ErrorKind =
  'invalid_input' | 'unauthenticated' | 'not_found' | 'rate_limited' | 'unavailable';

/** An expected, client-facing error. Its code, message and details are safe to return. */
export class AppError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
