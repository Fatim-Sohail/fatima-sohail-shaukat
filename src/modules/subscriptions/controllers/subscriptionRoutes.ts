import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { principalOf, requireRole } from '../../../shared/http/auth.js';
import { runBilling } from '../application/billingRun.js';
import {
  cancelSubscription,
  changeAutoRenew,
  getSubscription,
  listSubscriptions,
  subscribe,
  type SubscriptionDeps,
} from '../application/subscriptions.js';
import type { Subscription } from '../domain/entities/subscription.js';
import { BILLING_CYCLES, TIERS } from '../domain/entities/tiers.js';

const createBody = z.strictObject({
  tier: z.enum(TIERS),
  billingCycle: z.enum(BILLING_CYCLES),
  autoRenew: z.boolean(),
});

const updateBody = z.strictObject({ autoRenew: z.boolean() });

const idParams = z.strictObject({ id: z.uuid() });

const listQuery = z.strictObject({
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const noBody = z.strictObject({}).optional();

function present(sub: Subscription) {
  return {
    id: sub.id,
    userId: sub.userId,
    tier: sub.tier,
    billingCycle: sub.billingCycle,
    maxMessages: sub.maxMessages,
    messagesUsed: sub.messagesUsed,
    priceCents: sub.priceCents,
    autoRenew: sub.autoRenew,
    status: sub.status,
    startDate: sub.startDate,
    endDate: sub.endDate,
    renewalDate: sub.renewalDate,
    cancelledAt: sub.cancelledAt,
  };
}

export function registerSubscriptionRoutes(app: FastifyInstance, deps: SubscriptionDeps): void {
  const config = { rateLimitGroup: 'subscriptions' } as const;

  app.post('/subscriptions', { config }, async (request, reply) => {
    const body = createBody.parse(request.body);
    const sub = await subscribe(deps, principalOf(request), body);
    return reply.status(201).send(present(sub));
  });

  app.get('/subscriptions', { config }, async (request) => {
    const query = listQuery.parse(request.query);
    const subs = await listSubscriptions(deps, principalOf(request), query);
    return { items: subs.map(present) };
  });

  app.get('/subscriptions/:id', { config }, async (request) => {
    const { id } = idParams.parse(request.params);
    return present(await getSubscription(deps, principalOf(request), id));
  });

  app.patch('/subscriptions/:id', { config }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { autoRenew } = updateBody.parse(request.body);
    return present(await changeAutoRenew(deps, principalOf(request), id, autoRenew));
  });

  app.post('/subscriptions/:id/cancel', { config }, async (request) => {
    const { id } = idParams.parse(request.params);
    noBody.parse(request.body);
    return present(await cancelSubscription(deps, principalOf(request), id));
  });

  app.post('/admin/billing/run', { config, preHandler: requireRole('admin') }, async (request) => {
    noBody.parse(request.body);
    return runBilling(deps, principalOf(request));
  });
}
