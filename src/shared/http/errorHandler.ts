import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { AppError, type ErrorKind } from '../errors.js';

export interface ErrorBody {
  error: { code: string; message: string; details?: Readonly<Record<string, unknown>> };
  requestId: string;
}

interface HttpError {
  statusCode: number;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

const STATUS_BY_KIND: Record<ErrorKind, number> = {
  invalid_input: 400,
  unauthenticated: 401,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
};

/**
 * Framework-level client errors get stable codes and fixed messages; parser
 * messages are never forwarded because they can echo fragments of the input.
 */
const CLIENT_ERRORS: Partial<Record<number, { code: string; message: string }>> = {
  400: { code: 'BAD_REQUEST', message: 'The request is malformed' },
  404: { code: 'NOT_FOUND', message: 'Resource not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the size limit' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Request body must be application/json' },
};

const GENERIC_CLIENT_ERROR = { code: 'BAD_REQUEST', message: 'The request could not be processed' };

export function errorBody(
  request: FastifyRequest,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) }, requestId: request.id };
}

function statusCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    return typeof error.statusCode === 'number' ? error.statusCode : undefined;
  }
  return undefined;
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof AppError) {
    return {
      statusCode: STATUS_BY_KIND[error.kind],
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      message: 'Request validation failed',
      details: {
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      },
    };
  }

  if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }

  const statusCode = statusCodeOf(error);
  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return { statusCode, ...(CLIENT_ERRORS[statusCode] ?? GENERIC_CLIENT_ERROR) };
  }

  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
}

/** Every error leaves the API in the same JSON shape, without stack traces or internals. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const httpError = toHttpError(error);

    if (httpError.statusCode >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info(
        { statusCode: httpError.statusCode, code: httpError.code },
        'request rejected',
      );
    }

    return reply
      .status(httpError.statusCode)
      .send(errorBody(request, httpError.code, httpError.message, httpError.details));
  });
}
