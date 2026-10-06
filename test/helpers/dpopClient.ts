import { createHash, randomUUID } from 'node:crypto';

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';

/** A client's DPoP key pair, as a browser or mobile app would hold it. */
export interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jkt: string;
}

export interface ProofOptions {
  method: string;
  url: string;
  accessToken: string;
  /** Seconds added to the current time for `iat` (negative = in the past). */
  iatOffset?: number;
  /** Explicit jti; null omits it. Defaults to a random UUID. */
  jti?: string | null;
  /** Explicit ath; null omits it. Defaults to the hash of `accessToken`. */
  ath?: string | null;
  typ?: string;
  /** Public key placed in the header instead of the signer's (forges the signature). */
  embeddedJwk?: JWK;
}

export async function createDpopKey(): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk, 'sha256') };
}

export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('base64url');
}

/** Builds an ES256 DPoP proof; every field can be overridden to produce invalid proofs. */
export function createDpopProof(key: DpopKey, options: ProofOptions): Promise<string> {
  const payload: JWTPayload = {
    htm: options.method,
    htu: options.url,
    iat: Math.floor(Date.now() / 1000) + (options.iatOffset ?? 0),
  };
  const jti = options.jti === undefined ? randomUUID() : options.jti;
  const ath = options.ath === undefined ? accessTokenHash(options.accessToken) : options.ath;
  if (jti !== null) {
    payload.jti = jti;
  }
  if (ath !== null) {
    payload['ath'] = ath;
  }

  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'ES256',
      typ: options.typ ?? 'dpop+jwt',
      jwk: options.embeddedJwk ?? key.publicJwk,
    })
    .sign(key.privateKey);
}
