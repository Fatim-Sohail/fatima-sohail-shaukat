import { createHash, randomUUID } from 'node:crypto';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createAccessTokenVerifier,
  type AccessTokenVerifier,
} from '../../src/shared/auth/accessToken.js';
import {
  createDpopVerifier,
  DpopError,
  type DpopResult,
  type DpopVerifier,
} from '../../src/shared/auth/dpop.js';
import { createPool } from '../../src/shared/db/pool.js';
import {
  accessTokenHash,
  createDpopKey,
  createDpopProof,
  type DpopKey,
  type ProofOptions,
} from '../helpers/dpopClient.js';
import { startMockIdp, type MintOptions, type MockIdp } from '../helpers/mockIdp.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const API_URL = 'https://api.example.com/chat/messages';
const MAX_AGE_SECONDS = 60;

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('DPoP proof-of-possession', () => {
  let idp: MockIdp;
  let pool: Pool;
  let verifyToken: AccessTokenVerifier;
  let verifyDpop: DpopVerifier;

  beforeAll(async () => {
    idp = await startMockIdp();
    pool = createPool(TEST_DATABASE_URL);
    verifyToken = createAccessTokenVerifier(
      testConfig({
        OIDC_ISSUER: idp.issuer,
        OIDC_AUDIENCE: idp.audience,
        OIDC_JWKS_URI: idp.jwksUri,
      }),
    );
    verifyDpop = createDpopVerifier({ pool, proofMaxAgeSeconds: MAX_AGE_SECONDS });
  });
  afterEach(async () => {
    await pool.query('TRUNCATE dpop_replay, token_bindings');
  });
  afterAll(async () => {
    await idp.close();
    await pool.end();
  });

  /** A client holding a fresh key and access token, able to sign proofs for it. */
  async function client(tokenOptions?: MintOptions) {
    const key = await createDpopKey();
    const token = await idp.mintToken(tokenOptions);
    const proof = (overrides: Partial<ProofOptions> = {}, signer: DpopKey = key) =>
      createDpopProof(signer, { method: 'POST', url: API_URL, accessToken: token, ...overrides });
    return { key, token, proof };
  }

  /** The chain an authenticated request goes through: OIDC verification, then DPoP. */
  async function authenticate(
    token: string,
    proof: string | undefined,
    request: { method?: string; url?: string } = {},
  ): Promise<DpopResult> {
    const verifiedToken = await verifyToken(token);
    return verifyDpop({
      proof,
      accessToken: token,
      verifiedToken,
      method: request.method ?? 'POST',
      url: request.url ?? API_URL,
    });
  }

  /** Asserts a client-safe DPoP rejection (generic code, no details) and returns it. */
  async function rejection(attempt: Promise<unknown>): Promise<DpopError> {
    const error: unknown = await attempt.then(
      () => undefined,
      (rejected: unknown) => rejected,
    );
    expect(error).toBeInstanceOf(DpopError);
    expect((error as DpopError).details).toBeUndefined();
    return error as DpopError;
  }

  async function invalidProofReason(token: string, proof: string | undefined): Promise<string> {
    const error = await rejection(authenticate(token, proof));
    expect(error.code).toBe('INVALID_DPOP_PROOF');
    expect(error.message).toBe('DPoP proof is missing or invalid');
    return error.reason;
  }

  it('accepts a valid proof and returns the key thumbprint', async () => {
    const { key, token, proof } = await client();

    await expect(authenticate(token, await proof())).resolves.toEqual({ jkt: key.jkt });
  });

  it('accepts an iat inside the allowed window', async () => {
    const { token, proof } = await client();

    await expect(authenticate(token, await proof({ iatOffset: -55 }))).resolves.toBeDefined();
  });

  describe('proof structure', () => {
    it('rejects a missing proof', async () => {
      const { token } = await client();
      expect(await invalidProofReason(token, undefined)).toBe('missing');
    });

    it.each(['not-a-jwt', 'a.b.c', 'eyJhbGciOiJFUzI1NiJ9.e30'])(
      'rejects a malformed proof: %s',
      async (proof) => {
        const { token } = await client();
        expect(await invalidProofReason(token, proof)).toMatch(/^ERR_JW[ST]_INVALID$/);
      },
    );

    it('rejects a proof whose typ is not dpop+jwt', async () => {
      const { token, proof } = await client();
      expect(await invalidProofReason(token, await proof({ typ: 'JWT' }))).toBe(
        'ERR_JWT_CLAIM_VALIDATION_FAILED:typ',
      );
    });

    it('rejects a proof whose signature does not match the embedded key', async () => {
      const { token, proof } = await client();
      const otherKey = await createDpopKey();

      expect(
        await invalidProofReason(token, await proof({ embeddedJwk: otherKey.publicJwk })),
      ).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    });

    it('rejects a proof that embeds a private key', async () => {
      const { token } = await client();
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      const proof = await new SignJWT({
        htm: 'POST',
        htu: API_URL,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ath: accessTokenHash(token),
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(privateKey) })
        .sign(privateKey);

      expect(await invalidProofReason(token, proof)).toBe('ERR_JWS_INVALID');
    });

    it('rejects a symmetric HS256 proof', async () => {
      const { key, token } = await client();
      const proof = await new SignJWT({
        htm: 'POST',
        htu: API_URL,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ath: accessTokenHash(token),
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'dpop+jwt', jwk: key.publicJwk })
        .sign(new TextEncoder().encode('shared-secret-shared-secret-0123'));

      expect(await invalidProofReason(token, proof)).toBe('ERR_JOSE_ALG_NOT_ALLOWED');
    });

    it('rejects an unsigned alg:none proof', async () => {
      const { key, token } = await client();
      const header = base64url({ alg: 'none', typ: 'dpop+jwt', jwk: key.publicJwk });
      const payload = base64url({
        htm: 'POST',
        htu: API_URL,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ath: accessTokenHash(token),
      });

      expect(await invalidProofReason(token, `${header}.${payload}.`)).toBe(
        'ERR_JOSE_ALG_NOT_ALLOWED',
      );
    });
  });

  describe('proof claims', () => {
    it.each<[string, Partial<ProofOptions>, string]>([
      ['the wrong method (htm)', { method: 'GET' }, 'htm'],
      ['another path (htu)', { url: 'https://api.example.com/subscriptions' }, 'htu'],
      ['another host (htu)', { url: 'https://evil.example.com/chat/messages' }, 'htu'],
      ['a stale iat', { iatOffset: -(MAX_AGE_SECONDS + 30) }, 'iat'],
      ['an iat in the future', { iatOffset: MAX_AGE_SECONDS + 30 }, 'iat'],
      ['no jti', { jti: null }, 'jti'],
      ['an ath for another token', { ath: accessTokenHash('another-token') }, 'ath'],
      ['no ath', { ath: null }, 'ath'],
    ])('rejects a proof with %s', async (_label, overrides, reason) => {
      const { token, proof } = await client();
      expect(await invalidProofReason(token, await proof(overrides))).toBe(reason);
    });

    it('compares htu after normalization, ignoring query and fragment', async () => {
      const { token, proof } = await client();
      const signedFor = await proof({ url: 'HTTPS://API.EXAMPLE.COM:443/chat/messages?a=1#frag' });

      await expect(
        authenticate(token, signedFor, { url: `${API_URL}?page=2` }),
      ).resolves.toBeDefined();
    });
  });

  describe('replay protection', () => {
    it('rejects a proof that was already used', async () => {
      const { token, proof } = await client();
      const used = await proof();
      await authenticate(token, used);

      const error = await rejection(authenticate(token, used));
      expect(error).toMatchObject({ code: 'DPOP_REPLAY', reason: 'jti_reused' });
    });

    it('rejects a fresh proof that reuses a jti', async () => {
      const { token, proof } = await client();
      await authenticate(token, await proof({ jti: 'fixed-jti' }));

      const error = await rejection(authenticate(token, await proof({ jti: 'fixed-jti' })));
      expect(error.code).toBe('DPOP_REPLAY');
    });

    it('stores the jti with an expiry for later cleanup', async () => {
      const { token, proof } = await client();
      const before = Date.now();
      await authenticate(token, await proof({ jti: 'tracked-jti' }));

      const { rows } = await pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM dpop_replay WHERE jti = $1',
        ['tracked-jti'],
      );
      const expiresAt = rows[0]!.expires_at.getTime();
      expect(expiresAt).toBeGreaterThan(before + (MAX_AGE_SECONDS - 2) * 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + MAX_AGE_SECONDS * 1000);
    });

    it('allows a jti again once its record has expired', async () => {
      const { token, proof } = await client();
      await pool.query(
        `INSERT INTO dpop_replay (jti, expires_at) VALUES ('old-jti', now() - interval '1 hour')`,
      );

      await expect(authenticate(token, await proof({ jti: 'old-jti' }))).resolves.toBeDefined();
    });

    it('lets exactly one of many concurrent requests with the same proof succeed', async () => {
      // cnf-bound token, verified once up front, so all requests reach the replay check
      // together. (A non-atomic check-then-insert lets most of them through here.)
      const key = await createDpopKey();
      const token = await idp.mintToken({ claims: { cnf: { jkt: key.jkt } } });
      const verifiedToken = await verifyToken(token);
      const proof = await createDpopProof(key, {
        method: 'POST',
        url: API_URL,
        accessToken: token,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          verifyDpop({ proof, accessToken: token, verifiedToken, method: 'POST', url: API_URL }),
        ),
      );

      const rejected = results.filter((result) => result.status === 'rejected');
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const result of rejected) {
        expect(result.reason).toMatchObject({ code: 'DPOP_REPLAY' });
      }
    });
  });

  describe('token binding via cnf.jkt', () => {
    it('accepts a proof signed by the key named in cnf.jkt', async () => {
      const key = await createDpopKey();
      const token = await idp.mintToken({ claims: { cnf: { jkt: key.jkt } } });
      const proof = await createDpopProof(key, {
        method: 'POST',
        url: API_URL,
        accessToken: token,
      });

      await expect(authenticate(token, proof)).resolves.toEqual({ jkt: key.jkt });
      const { rowCount } = await pool.query('SELECT 1 FROM token_bindings');
      expect(rowCount).toBe(0);
    });

    it('rejects a proof signed by any other key', async () => {
      const boundKey = await createDpopKey();
      const { token, proof } = await client({ claims: { cnf: { jkt: boundKey.jkt } } });

      const error = await rejection(authenticate(token, await proof()));
      expect(error).toMatchObject({ code: 'DPOP_KEY_MISMATCH', reason: 'cnf_jkt_mismatch' });
    });
  });

  describe('first-use token binding (no cnf.jkt)', () => {
    it('stores the token hash bound to the first proof key until the token expires', async () => {
      const { key, token, proof } = await client();
      await authenticate(token, await proof());

      const { rows } = await pool.query<{ jkt: string; expires_at: Date }>(
        'SELECT jkt, expires_at FROM token_bindings WHERE token_hash = $1',
        [createHash('sha256').update(token).digest('hex')],
      );
      expect(rows).toEqual([{ jkt: key.jkt, expires_at: (await verifyToken(token)).expiresAt }]);
    });

    it('keeps accepting new proofs from the bound key', async () => {
      const { token, proof } = await client();
      await authenticate(token, await proof());

      await expect(authenticate(token, await proof())).resolves.toBeDefined();
    });

    it('rejects the same token used with a different key', async () => {
      const { token, proof } = await client();
      await authenticate(token, await proof());

      const thiefKey = await createDpopKey();
      const error = await rejection(authenticate(token, await proof({}, thiefKey)));
      expect(error).toMatchObject({
        code: 'DPOP_KEY_MISMATCH',
        reason: 'token_bound_to_other_key',
        message: 'DPoP proof key does not match the access token',
      });
    });

    it('binds to exactly one key when first uses race with different keys', async () => {
      // Token verified once up front so the first uses reach the binding step together.
      const { token, proof } = await client();
      const verifiedToken = await verifyToken(token);
      const keys = await Promise.all(Array.from({ length: 10 }, () => createDpopKey()));
      const proofs = await Promise.all(keys.map((key) => proof({}, key)));

      const results = await Promise.allSettled(
        proofs.map((signed) =>
          verifyDpop({
            proof: signed,
            accessToken: token,
            verifiedToken,
            method: 'POST',
            url: API_URL,
          }),
        ),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        expect(result.reason).toMatchObject({ code: 'DPOP_KEY_MISMATCH' });
      }
    });
  });
});
