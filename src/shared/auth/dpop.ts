import { createHash } from 'node:crypto';

import { calculateJwkThumbprint, EmbeddedJWK, errors, jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from 'pg';

import { AppError } from '../errors.js';
import type { VerifiedAccessToken } from './accessToken.js';

/** Asymmetric algorithms only: the proof key is public by definition, so HMAC/none make no sense. */
const DPOP_ALGORITHMS = [
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
  'Ed25519',
];

type DpopErrorCode = 'INVALID_DPOP_PROOF' | 'DPOP_REPLAY' | 'DPOP_KEY_MISMATCH';

const MESSAGES: Record<DpopErrorCode, string> = {
  INVALID_DPOP_PROOF: 'DPoP proof is missing or invalid',
  DPOP_REPLAY: 'DPoP proof has already been used',
  DPOP_KEY_MISMATCH: 'DPoP proof key does not match the access token',
};

/** Generic code and message for clients; `reason` is for logs and tests only. */
export class DpopError extends AppError {
  constructor(
    code: DpopErrorCode,
    readonly reason: string,
  ) {
    super('unauthenticated', code, MESSAGES[code]);
    this.name = 'DpopError';
  }
}

export interface DpopRequest {
  /** Value of the DPoP header; undefined when absent. */
  proof: string | undefined;
  /** The raw access token from `Authorization: DPoP <token>`. */
  accessToken: string;
  /** The access token after OIDC verification. */
  verifiedToken: Pick<VerifiedAccessToken, 'confirmationJkt' | 'expiresAt'>;
  method: string;
  /** Absolute URL of the request as the client addressed it. */
  url: string;
}

export interface DpopResult {
  /** JWK SHA-256 thumbprint of the key that signed the proof. */
  jkt: string;
}

export type DpopVerifier = (request: DpopRequest) => Promise<DpopResult>;

function invalidProof(reason: string): never {
  throw new DpopError('INVALID_DPOP_PROOF', reason);
}

/** RFC 9449 §4.3: htu is compared without query and fragment, after URL normalization. */
function normalizeHtu(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Verifies the proof JWT: typ, pinned algorithm, signature by the embedded public
 * key (private keys are rejected by EmbeddedJWK), then the RFC 9449 claims.
 */
async function verifyProof(
  request: DpopRequest,
  now: Date,
  maxAgeSeconds: number,
): Promise<{ jti: string; iat: number; jkt: string }> {
  if (request.proof === undefined || request.proof.length === 0) {
    invalidProof('missing');
  }

  let payload: JWTPayload;
  let jkt: string;
  try {
    const verified = await jwtVerify(request.proof, EmbeddedJWK, {
      typ: 'dpop+jwt',
      algorithms: DPOP_ALGORITHMS,
    });
    payload = verified.payload;
    jkt = await calculateJwkThumbprint(verified.protectedHeader.jwk ?? {}, 'sha256');
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      const claim = error instanceof errors.JWTClaimValidationFailed ? `:${error.claim}` : '';
      invalidProof(`${error.code}${claim}`);
    }
    throw error;
  }

  const { jti, iat } = payload;
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 255) {
    invalidProof('jti');
  }
  if (payload['htm'] !== request.method) {
    invalidProof('htm');
  }
  const htu = normalizeHtu(payload['htu']);
  if (htu === null || htu !== normalizeHtu(request.url)) {
    invalidProof('htu');
  }
  if (typeof iat !== 'number' || Math.abs(now.getTime() / 1000 - iat) > maxAgeSeconds) {
    invalidProof('iat');
  }
  const expectedAth = createHash('sha256').update(request.accessToken).digest('base64url');
  if (payload['ath'] !== expectedAth) {
    invalidProof('ath');
  }

  return { jti, iat, jkt };
}

/**
 * The proof key must be the key the token is bound to: `cnf.jkt` when the provider
 * binds tokens itself, otherwise the key first used with this token (stored by hash).
 */
async function assertKeyBinding(pool: Pool, request: DpopRequest, jkt: string): Promise<void> {
  const { confirmationJkt, expiresAt } = request.verifiedToken;
  if (confirmationJkt !== null) {
    if (confirmationJkt !== jkt) {
      throw new DpopError('DPOP_KEY_MISMATCH', 'cnf_jkt_mismatch');
    }
    return;
  }

  const tokenHash = createHash('sha256').update(request.accessToken).digest('hex');
  // Concurrent first uses race on the primary key: exactly one INSERT wins, the others
  // wait for it to commit, do nothing, and then read the winner's key below.
  const inserted = await pool.query(
    `INSERT INTO token_bindings (token_hash, jkt, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, jkt, expiresAt],
  );
  if (inserted.rowCount === 1) {
    return;
  }

  const { rows } = await pool.query<{ jkt: string }>(
    'SELECT jkt FROM token_bindings WHERE token_hash = $1',
    [tokenHash],
  );
  if (rows[0]?.jkt !== jkt) {
    throw new DpopError('DPOP_KEY_MISMATCH', 'token_bound_to_other_key');
  }
}

/**
 * Records the proof's jti in one atomic statement. The primary key serializes
 * concurrent inserts, so at most one request per jti succeeds. An existing row is
 * only replaced once expired (judged by the app clock, the same clock as the iat
 * check), at which point the original proof can no longer pass the iat window.
 */
async function recordJti(
  pool: Pool,
  proof: { jti: string; iat: number },
  now: Date,
  maxAgeSeconds: number,
): Promise<void> {
  const expiresAt = new Date((proof.iat + maxAgeSeconds) * 1000);
  const { rowCount } = await pool.query(
    `INSERT INTO dpop_replay (jti, expires_at) VALUES ($1, $2)
     ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at
       WHERE dpop_replay.expires_at < $3`,
    [proof.jti, expiresAt, now],
  );
  if (rowCount !== 1) {
    throw new DpopError('DPOP_REPLAY', 'jti_reused');
  }
}

/**
 * DPoP (RFC 9449) proof-of-possession verifier. Framework-free: callers pass the
 * proof header, the access token (already OIDC-verified), the method and URL.
 */
export function createDpopVerifier(deps: { pool: Pool; proofMaxAgeSeconds: number }): DpopVerifier {
  return async (request) => {
    const now = new Date();
    const proof = await verifyProof(request, now, deps.proofMaxAgeSeconds);
    await assertKeyBinding(deps.pool, request, proof.jkt);
    await recordJti(deps.pool, proof, now, deps.proofMaxAgeSeconds);
    return { jkt: proof.jkt };
  };
}
