import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { createDpopKey, createDpopProof, type DpopKey } from './dpopClient.js';
import type { MockIdp } from './mockIdp.js';

export const BASE_URL = 'https://api.example.com';

/** A signed-in client: an access token plus the DPoP key it is used with. */
export interface Session {
  key: DpopKey;
  token: string;
}

export async function login(
  idp: MockIdp,
  subject: string,
  roles: string[] = ['user'],
): Promise<Session> {
  return {
    key: await createDpopKey(),
    token: await idp.mintToken({ subject, claims: { roles } }),
  };
}

/** Sends an authenticated request with a fresh DPoP proof, like a real client would. */
export async function call(
  app: FastifyInstance,
  session: Session,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const proof = await createDpopProof(session.key, {
    method,
    url: `${BASE_URL}${url}`,
    accessToken: session.token,
  });
  return app.inject({
    method,
    url,
    headers: { authorization: `DPoP ${session.token}`, dpop: proof },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
}
