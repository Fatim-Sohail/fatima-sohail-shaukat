import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

import { assertAdmin } from '../../../shared/auth/policy.js';
import { principalOf, requireRole } from '../../../shared/http/auth.js';
import { monthStart } from '../../chat/domain/services/quota.js';
import { readMetrics } from '../repositories/metricsRepository.js';

export function registerMetricsRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; now: () => Date },
): void {
  app.get(
    '/metrics',
    { config: { rateLimitGroup: 'auth' }, preHandler: requireRole('admin') },
    async (request) => {
      z.strictObject({}).parse(request.query);
      assertAdmin(principalOf(request));

      const now = deps.now();
      const start = monthStart(now);
      const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      const metrics = await readMetrics(deps.pool, {
        monthStart: start,
        nextMonthStart: next,
        now,
      });

      const active = metrics.activeSubscriptions;
      return {
        generatedAt: now,
        month: start.toISOString().slice(0, 7),
        users: { total: metrics.users },
        chats: { thisMonth: metrics.chatsThisMonth },
        subscriptions: {
          active: {
            basic: active.basic,
            pro: active.pro,
            enterprise: active.enterprise,
            total: active.basic + active.pro + active.enterprise,
          },
        },
        payments: metrics.payments,
      };
    },
  );
}
