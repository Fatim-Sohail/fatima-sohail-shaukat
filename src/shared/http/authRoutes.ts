import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { principalOf } from './auth.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/auth/me', { config: { rateLimitGroup: 'auth' } }, (request) => {
    z.strictObject({}).parse(request.query);
    const { userId, issuer, subject, roles } = principalOf(request);
    return { userId, issuer, subject, roles };
  });
}
