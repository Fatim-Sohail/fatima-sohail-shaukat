import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { Pool } from 'pg';

import { extractDpopToken, type AccessTokenVerifier } from '../auth/accessToken.js';
import type { DpopVerifier } from '../auth/dpop.js';
import type { Principal, Role } from '../auth/policy.js';
import { findOrCreateUser } from '../auth/users.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export type RateLimitGroup = 'auth' | 'chat' | 'subscriptions';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    /** Skips authentication. Only for infrastructure probes such as /health. */
    public?: boolean;
    /** Per-user rate-limit bucket; required on every authenticated route. */
    rateLimitGroup?: RateLimitGroup;
  }
}

export interface AuthDeps {
  config: Config;
  pool: Pool;
  verifyToken: AccessTokenVerifier;
  verifyDpop: DpopVerifier;
}

/**
 * Default-deny: every route registered after this call gets authentication and a
 * per-user rate limit, unless it is explicitly marked `config.public`.
 */
export function registerAuthentication(app: FastifyInstance, deps: AuthDeps): void {
  const { config } = deps;
  app.decorateRequest('principal', null);

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const accessToken = extractDpopToken(request.headers.authorization);
    const token = await deps.verifyToken(accessToken);
    const proof = request.headers['dpop'];
    await deps.verifyDpop({
      proof: typeof proof === 'string' ? proof : undefined,
      accessToken,
      verifiedToken: token,
      method: request.method,
      // Built from configuration, never from Host / X-Forwarded-* which the client controls.
      url: `${config.PUBLIC_BASE_URL}${request.url}`,
    });

    const userId = await findOrCreateUser(deps.pool, token.issuer, token.subject);
    request.principal = {
      userId,
      issuer: token.issuer,
      subject: token.subject,
      roles: token.roles,
    };
  };

  // createRateLimit rather than rateLimit(): handlers from rateLimit() share a "ran" flag
  // with the global per-IP limiter, so a second one on the same request is silently skipped.
  const userLimit = (max: number) => {
    const check = app.createRateLimit({
      max,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyGenerator: (request) => request.principal?.userId ?? request.ip,
    });
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const result = await check(request);
      if (!result.isAllowed && result.isExceeded) {
        void reply.header('retry-after', result.ttlInSeconds);
        throw new AppError('rate_limited', 'RATE_LIMITED', 'Too many requests, retry later', {
          retryAfterSeconds: result.ttlInSeconds,
        });
      }
    };
  };
  const userLimits: Record<RateLimitGroup, ReturnType<typeof userLimit>> = {
    auth: userLimit(config.RATE_LIMIT_AUTH_MAX),
    chat: userLimit(config.RATE_LIMIT_CHAT_MAX),
    subscriptions: userLimit(config.RATE_LIMIT_SUBSCRIPTION_MAX),
  };

  // Registered after @fastify/rate-limit's own onRoute hook, so the per-IP limit still runs first.
  app.addHook('onRoute', (route) => {
    if (route.config?.public === true) {
      return;
    }
    const group = route.config?.rateLimitGroup;
    if (!group) {
      throw new Error(`${String(route.method)} ${route.url} must set config.rateLimitGroup`);
    }
    const existing = route.onRequest ?? [];
    route.onRequest = [
      ...(Array.isArray(existing) ? existing : [existing]),
      authenticate,
      userLimits[group],
    ];
  });
}

/** The authenticated caller. Throws if used on a route without authentication. */
export function principalOf(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AppError('unauthenticated', 'UNAUTHENTICATED', 'Authentication required');
  }
  return request.principal;
}

export function requireRole(role: Role) {
  return (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    if (request.principal?.roles.includes(role)) {
      done();
    } else {
      done(new AppError('forbidden', 'FORBIDDEN', 'Insufficient permissions'));
    }
  };
}
