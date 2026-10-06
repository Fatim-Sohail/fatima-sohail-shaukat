import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';

export interface MintOptions {
  /** Extra or overriding payload claims (e.g. roles). */
  claims?: JWTPayload;
  subject?: string;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative for an already-expired token, null to omit `exp`. */
  expiresIn?: number | null;
  /** Seconds from now for `nbf`; omitted when undefined. */
  notBefore?: number;
  /** Sign with a key that is not published in the JWKS. */
  untrustedKey?: boolean;
  /** Override the `kid` header, e.g. to impersonate the trusted key. */
  kid?: string;
}

export interface MockIdp {
  issuer: string;
  jwksUri: string;
  audience: string;
  mintToken(options?: MintOptions): Promise<string>;
  /** HS256 token signed with an arbitrary secret, for algorithm-confusion tests. */
  mintHs256Token(): Promise<string>;
  /** Unsigned `alg: none` token carrying otherwise valid claims. */
  unsignedToken(): string;
  close(): Promise<void>;
}

const TRUSTED_KID = 'mock-idp-key-1';
const AUDIENCE = 'ggi-api';

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Minimal OIDC provider for tests: an RSA key pair, a real JWKS endpoint over HTTP
 * and a token minter. The app verifies its tokens through the production code path.
 */
export async function startMockIdp(): Promise<MockIdp> {
  const trusted = await generateKeyPair('RS256');
  const untrusted = await generateKeyPair('RS256');
  const jwks = {
    keys: [{ ...(await exportJWK(trusted.publicKey)), kid: TRUSTED_KID, alg: 'RS256', use: 'sig' }],
  };

  const server = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwks));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}`;

  const validClaims = (): JWTPayload => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: issuer, aud: AUDIENCE, sub: 'user-123', iat: now, exp: now + 300 };
  };

  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    audience: AUDIENCE,

    async mintToken(options = {}) {
      const now = Math.floor(Date.now() / 1000);
      const jwt = new SignJWT({ ...options.claims })
        .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? TRUSTED_KID, typ: 'JWT' })
        .setIssuer(options.issuer ?? issuer)
        .setAudience(options.audience ?? AUDIENCE)
        .setSubject(options.subject ?? 'user-123')
        .setIssuedAt(now);
      if (options.expiresIn !== null) {
        jwt.setExpirationTime(now + (options.expiresIn ?? 300));
      }
      if (options.notBefore !== undefined) {
        jwt.setNotBefore(now + options.notBefore);
      }
      return jwt.sign(options.untrustedKey ? untrusted.privateKey : trusted.privateKey);
    },

    async mintHs256Token() {
      return new SignJWT(validClaims())
        .setProtectedHeader({ alg: 'HS256', kid: TRUSTED_KID })
        .sign(new TextEncoder().encode('attacker-chosen-shared-secret-0123456789'));
    },

    unsignedToken() {
      return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(validClaims())}.`;
    },

    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
