import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';

import type { Config } from '../config.js';
import { AppError } from '../errors.js';

export interface VerifiedAccessToken {
  issuer: string;
  subject: string;
  roles: readonly string[];
  expiresAt: Date;
}

export type AccessTokenVerifier = (token: string) => Promise<VerifiedAccessToken>;

/**
 * Rejection of the token itself. `reason` is for logs and tests only; clients
 * always receive the same generic code and message.
 */
export class InvalidAccessTokenError extends AppError {
  constructor(readonly reason: string) {
    super('unauthenticated', 'INVALID_TOKEN', 'Access token is invalid or expired');
    this.name = 'InvalidAccessTokenError';
  }
}

/** Failures caused by the token; anything else (JWKS unreachable, timeout, bad JWKS) is ours. */
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

const CLOCK_TOLERANCE_SECONDS = 5;

/** Bearer token from an Authorization header (RFC 6750); the scheme is case-insensitive. */
export function extractBearerToken(authorization: string | undefined): string {
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization ?? '');
  if (!match?.[1]) {
    throw new AppError('unauthenticated', 'MISSING_TOKEN', 'A Bearer access token is required');
  }
  return match[1];
}

/**
 * Resolves a claim by exact name first (namespaced claims such as
 * "https://example.com/roles" contain dots), then as a dot-path ("realm_access.roles").
 */
function readClaim(payload: JWTPayload, path: string): unknown {
  if (path in payload) {
    return payload[path];
  }
  let value: unknown = payload;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function rolesFrom(payload: JWTPayload, rolesClaim: string): readonly string[] {
  const roles = readClaim(payload, rolesClaim);
  if (roles === undefined) {
    return [];
  }
  // Fail closed: a malformed roles claim must never be guessed into permissions.
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) {
    throw new InvalidAccessTokenError('roles_claim_invalid');
  }
  return roles;
}

/**
 * Verifies OIDC access tokens (JWT) against the provider's JWKS: signature with
 * pinned asymmetric algorithms, issuer, audience, expiry (required) and not-before.
 */
export function createAccessTokenVerifier(
  config: Pick<
    Config,
    'OIDC_ISSUER' | 'OIDC_AUDIENCE' | 'OIDC_JWKS_URI' | 'OIDC_ALGORITHMS' | 'OIDC_ROLES_CLAIM'
  >,
): AccessTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(config.OIDC_JWKS_URI));

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: config.OIDC_ISSUER,
        audience: config.OIDC_AUDIENCE,
        algorithms: [...config.OIDC_ALGORITHMS],
        requiredClaims: ['sub', 'exp'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      if (TOKEN_ERRORS.some((tokenError) => error instanceof tokenError)) {
        const { code } = error as errors.JOSEError;
        const claim = error instanceof errors.JWTClaimValidationFailed ? `:${error.claim}` : '';
        throw new InvalidAccessTokenError(`${code}${claim}`);
      }
      throw new AppError(
        'unavailable',
        'AUTH_PROVIDER_UNAVAILABLE',
        'Unable to verify credentials, retry later',
      );
    }

    return {
      // Both are guaranteed by the issuer check and requiredClaims above.
      issuer: config.OIDC_ISSUER,
      subject: payload.sub as string,
      roles: rolesFrom(payload, config.OIDC_ROLES_CLAIM),
      expiresAt: new Date((payload.exp as number) * 1000),
    };
  };
}
