import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAccessTokenVerifier,
  extractBearerToken,
  extractDpopToken,
  InvalidAccessTokenError,
  type AccessTokenVerifier,
} from '../../src/shared/auth/accessToken.js';
import type { AppError } from '../../src/shared/errors.js';
import { testConfig } from '../helpers/testApp.js';
import { startMockIdp, type MintOptions, type MockIdp } from '../helpers/mockIdp.js';

describe('OIDC access token verification', () => {
  let idp: MockIdp;
  let verify: AccessTokenVerifier;

  function verifierFor(overrides: Record<string, string> = {}): AccessTokenVerifier {
    return createAccessTokenVerifier(
      testConfig({
        OIDC_ISSUER: idp.issuer,
        OIDC_AUDIENCE: idp.audience,
        OIDC_JWKS_URI: idp.jwksUri,
        OIDC_ROLES_CLAIM: 'realm_access.roles',
        ...overrides,
      }),
    );
  }

  /** Asserts a generic client-facing rejection and returns the internal reason. */
  async function rejectionReason(token: string, verifier = verify): Promise<string> {
    const error: unknown = await verifier(token).then(
      () => undefined,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(InvalidAccessTokenError);
    expect(error).toMatchObject({
      kind: 'unauthenticated',
      code: 'INVALID_TOKEN',
      message: 'Access token is invalid or expired',
      details: undefined,
    });
    return (error as InvalidAccessTokenError).reason;
  }

  beforeAll(async () => {
    idp = await startMockIdp();
    verify = verifierFor();
  });
  afterAll(async () => {
    await idp.close();
  });

  it('accepts a valid token and returns the principal', async () => {
    const token = await idp.mintToken({ claims: { realm_access: { roles: ['user', 'admin'] } } });

    const principal = await verify(token);

    expect(principal).toEqual({
      issuer: idp.issuer,
      subject: 'user-123',
      roles: ['user', 'admin'],
      expiresAt: expect.any(Date) as Date,
      confirmationJkt: null,
    });
    expect(principal.expiresAt.getTime()).toBeGreaterThan(Date.now() + 290_000);
  });

  describe('cnf (proof-of-possession confirmation) claim', () => {
    it('exposes cnf.jkt for DPoP-bound tokens', async () => {
      const token = await idp.mintToken({ claims: { cnf: { jkt: 'thumbprint-abc' } } });
      expect((await verify(token)).confirmationJkt).toBe('thumbprint-abc');
    });

    it.each([
      ['without jkt (e.g. an mTLS binding)', { 'x5t#S256': 'abc' }],
      ['with a non-string jkt', { jkt: 42 }],
      ['that is not an object', 'jkt'],
    ])('rejects a cnf claim %s', async (_label, cnf) => {
      expect(await rejectionReason(await idp.mintToken({ claims: { cnf } }))).toBe(
        'cnf_claim_invalid',
      );
    });
  });

  describe('Authorization header', () => {
    it('extracts a Bearer token regardless of scheme case', () => {
      expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
      expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    });

    it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer a b', 'Token abc'])(
      'rejects a missing token (%s)',
      (header) => {
        expect(() => extractBearerToken(header)).toThrow(
          expect.objectContaining({ kind: 'unauthenticated', code: 'MISSING_TOKEN' }) as AppError,
        );
      },
    );

    it('extracts a DPoP-scheme token regardless of scheme case', () => {
      expect(extractDpopToken('DPoP abc.def.ghi')).toBe('abc.def.ghi');
      expect(extractDpopToken('dpop abc.def.ghi')).toBe('abc.def.ghi');
    });

    it.each([undefined, '', 'DPoP', 'Bearer abc.def.ghi', 'DPoP a b'])(
      'rejects a missing DPoP-scheme token (%s)',
      (header) => {
        expect(() => extractDpopToken(header)).toThrow(
          expect.objectContaining({ kind: 'unauthenticated', code: 'MISSING_TOKEN' }) as AppError,
        );
      },
    );
  });

  it.each(['not-a-jwt', 'a.b.c', 'eyJhbGciOiJSUzI1NiJ9.e30'])(
    'rejects a malformed token: %s',
    async (token) => {
      expect(await rejectionReason(token)).toMatch(/^ERR_JW[ST]_INVALID$/);
    },
  );

  it.each<[string, MintOptions, string]>([
    ['expired', { expiresIn: -60 }, 'ERR_JWT_EXPIRED'],
    ['without an expiry', { expiresIn: null }, 'ERR_JWT_CLAIM_VALIDATION_FAILED:exp'],
    [
      'from the wrong issuer',
      { issuer: 'https://evil.example.com' },
      'ERR_JWT_CLAIM_VALIDATION_FAILED:iss',
    ],
    ['for the wrong audience', { audience: 'another-api' }, 'ERR_JWT_CLAIM_VALIDATION_FAILED:aud'],
    ['not yet valid', { notBefore: 120 }, 'ERR_JWT_CLAIM_VALIDATION_FAILED:nbf'],
  ])('rejects a token %s', async (_label, options, reason) => {
    expect(await rejectionReason(await idp.mintToken(options))).toBe(reason);
  });

  describe('signing key', () => {
    it('rejects a token signed by a key absent from the JWKS', async () => {
      const token = await idp.mintToken({ untrustedKey: true, kid: 'unknown-key' });
      expect(await rejectionReason(token)).toBe('ERR_JWKS_NO_MATCHING_KEY');
    });

    it('rejects a token signed by another key that claims the trusted kid', async () => {
      const token = await idp.mintToken({ untrustedKey: true });
      expect(await rejectionReason(token)).toBe('ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    });

    it('rejects a token whose payload was tampered with', async () => {
      const [header, , signature] = (await idp.mintToken()).split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ iss: idp.issuer, aud: idp.audience, sub: 'admin', exp: 9_999_999_999 }),
      ).toString('base64url');

      expect(await rejectionReason(`${header!}.${forgedPayload}.${signature!}`)).toBe(
        'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      );
    });
  });

  describe('algorithm pinning', () => {
    it('rejects an HS256 token (algorithm confusion)', async () => {
      expect(await rejectionReason(await idp.mintHs256Token())).toBe('ERR_JOSE_ALG_NOT_ALLOWED');
    });

    it('rejects an unsigned alg:none token', async () => {
      expect(await rejectionReason(idp.unsignedToken())).toBe('ERR_JOSE_ALG_NOT_ALLOWED');
    });
  });

  describe('roles claim', () => {
    it('reads roles from a nested dot-path such as realm_access.roles', async () => {
      const token = await idp.mintToken({
        claims: { realm_access: { roles: ['admin'] }, roles: ['ignored'] },
      });
      expect((await verify(token)).roles).toEqual(['admin']);
    });

    it('reads a namespaced claim whose name contains dots', async () => {
      const claim = 'https://ggi.example.com/roles';
      const token = await idp.mintToken({ claims: { [claim]: ['user'] } });

      expect((await verifierFor({ OIDC_ROLES_CLAIM: claim })(token)).roles).toEqual(['user']);
    });

    it('returns no roles when the claim is absent', async () => {
      expect((await verify(await idp.mintToken())).roles).toEqual([]);
    });

    it.each([
      ['a string', { realm_access: { roles: 'admin' } }],
      ['non-string entries', { realm_access: { roles: ['admin', 42] } }],
    ])('rejects a roles claim containing %s', async (_label, claims) => {
      expect(await rejectionReason(await idp.mintToken({ claims }))).toBe('roles_claim_invalid');
    });
  });

  it('fails with 503-class AUTH_PROVIDER_UNAVAILABLE when the JWKS cannot be fetched', async () => {
    const verifier = verifierFor({ OIDC_JWKS_URI: 'http://127.0.0.1:1/jwks' });

    await expect(verifier(await idp.mintToken())).rejects.toMatchObject({
      kind: 'unavailable',
      code: 'AUTH_PROVIDER_UNAVAILABLE',
    });
  });
});
