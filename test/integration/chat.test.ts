import { setTimeout as sleep } from 'node:timers/promises';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { AiProvider } from '../../src/modules/chat/domain/services/aiProvider.js';
import { createPool } from '../../src/shared/db/pool.js';
import { createDpopProof } from '../helpers/dpopClient.js';
import { startMockIdp, type MockIdp } from '../helpers/mockIdp.js';
import { BASE_URL, call, login, type Session } from '../helpers/session.js';
import { testConfig } from '../helpers/testApp.js';
import { TEST_DATABASE_URL } from '../helpers/testDatabase.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const OCTOBER = '2026-10-01';
const days = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);

interface Chat {
  id: string;
  userId: string;
  question: string;
  answer: string;
  tokens: { prompt: number; completion: number; total: number };
  quotaSource: 'free' | 'subscription';
  subscriptionId: string | null;
  requestId: string;
  createdAt: string;
}

describe('chat API', () => {
  let idp: MockIdp;
  let pool: Pool;
  let app: FastifyInstance;
  let clock: Date;

  beforeAll(async () => {
    idp = await startMockIdp();
    pool = createPool(TEST_DATABASE_URL);
  });
  afterEach(async () => {
    await app.close();
    await pool.query(
      'TRUNCATE users, subscriptions, payments, chat_messages, monthly_usage, dpop_replay, token_bindings CASCADE',
    );
  });
  afterAll(async () => {
    await idp.close();
    await pool.end();
  });

  async function start(options: { env?: Record<string, string>; ai?: AiProvider } = {}) {
    clock = NOW;
    app = await buildApp({
      config: testConfig({
        OIDC_ISSUER: idp.issuer,
        OIDC_AUDIENCE: idp.audience,
        OIDC_JWKS_URI: idp.jwksUri,
        PUBLIC_BASE_URL: BASE_URL,
        RATE_LIMIT_CHAT_MAX: '200',
        AI_MOCK_LATENCY_MS: '0',
        ...options.env,
      }),
      pool,
      now: () => clock,
      ...(options.ai ? { ai: options.ai } : {}),
    });
    await app.ready();
  }

  async function userId(session: Session): Promise<string> {
    return (await call(app, session, 'GET', '/auth/me')).json<{ userId: string }>().userId;
  }

  const ask = (session: Session, body: unknown, headers: Record<string, string> = {}) =>
    call(app, session, 'POST', '/chat/messages', body, headers);

  async function addBundle(
    owner: string,
    options: {
      maxMessages?: number | null;
      messagesUsed?: number;
      status?: string;
      end?: Date;
    } = {},
  ): Promise<string> {
    const maxMessages = options.maxMessages === undefined ? 10 : options.maxMessages;
    const tier = maxMessages === null ? 'enterprise' : maxMessages > 10 ? 'pro' : 'basic';
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, tier, billing_cycle, max_messages, messages_used,
         price_cents, auto_renew, status, start_date, end_date)
       VALUES ($1, $2, 'monthly', $3, $4, 999, false, $5, $6, $7) RETURNING id`,
      [
        owner,
        tier,
        maxMessages,
        options.messagesUsed ?? 0,
        options.status ?? 'active',
        days(-10),
        options.end ?? days(20),
      ],
    );
    return rows[0]!.id;
  }

  async function setFreeUsed(owner: string, freeUsed: number, period = OCTOBER): Promise<void> {
    await pool.query(
      'INSERT INTO monthly_usage (user_id, period, free_used, total_used) VALUES ($1, $2, $3, $3)',
      [owner, period, freeUsed],
    );
  }

  async function usageRow(owner: string) {
    const { rows } = await pool.query<{ free_used: number; total_used: number }>(
      'SELECT free_used, total_used FROM monthly_usage WHERE user_id = $1 AND period = $2',
      [owner, OCTOBER],
    );
    return rows[0] ?? { free_used: 0, total_used: 0 };
  }

  async function chatCount(owner?: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM chat_messages WHERE $1::uuid IS NULL OR user_id = $1',
      [owner ?? null],
    );
    return Number(rows[0]!.count);
  }

  async function messagesUsed(subscriptionId: string): Promise<number> {
    const { rows } = await pool.query<{ messages_used: number }>(
      'SELECT messages_used FROM subscriptions WHERE id = $1',
      [subscriptionId],
    );
    return rows[0]!.messages_used;
  }

  async function eventually(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (!(await check())) {
      if (Date.now() > deadline) {
        throw new Error('condition not met in time');
      }
      await sleep(20);
    }
  }

  describe('POST /chat/messages', () => {
    it('answers and stores the chat with tokens, model, request ID and the caller as owner', async () => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);

      const response = await ask(
        alice,
        { question: 'How does DPoP binding work?' },
        { 'x-request-id': 'chat-req-0001' },
      );

      expect(response.statusCode).toBe(201);
      const chat = response.json<Chat>();
      expect(chat).toEqual({
        id: expect.any(String) as string,
        userId: aliceId,
        question: 'How does DPoP binding work?',
        answer: 'This is a simulated answer to your 5-word question.',
        tokens: { prompt: 7, completion: 13, total: 20 },
        quotaSource: 'free',
        subscriptionId: null,
        requestId: 'chat-req-0001',
        createdAt: NOW.toISOString(),
      });

      const { rows } = await pool.query('SELECT * FROM chat_messages WHERE id = $1', [chat.id]);
      expect(rows).toEqual([
        {
          id: chat.id,
          user_id: aliceId,
          question: 'How does DPoP binding work?',
          answer: chat.answer,
          model: 'mock-gpt-4o-mini',
          prompt_tokens: 7,
          completion_tokens: 13,
          total_tokens: 20,
          quota_source: 'free',
          subscription_id: null,
          request_id: 'chat-req-0001',
          created_at: NOW,
        },
      ]);
    });

    it('uses the 3 free messages first, then the subscription', async () => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      const basic = await addBundle(aliceId);

      const sources = [];
      for (let i = 0; i < 4; i++) {
        const chat = (await ask(alice, { question: `Question ${i}` })).json<Chat>();
        sources.push([chat.quotaSource, chat.subscriptionId]);
      }

      expect(sources).toEqual([
        ['free', null],
        ['free', null],
        ['free', null],
        ['subscription', basic],
      ]);
      expect(await usageRow(aliceId)).toEqual({ free_used: 3, total_used: 4 });
      expect(await messagesUsed(basic)).toBe(1);
    });

    it('charges the bundle with the most messages left, and Enterprise as unlimited', async () => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      await setFreeUsed(aliceId, 3);
      const basic = await addBundle(aliceId, { messagesUsed: 2 });
      await addBundle(aliceId, { maxMessages: 100, messagesUsed: 95 });

      expect((await ask(alice, { question: 'Which bundle?' })).json<Chat>().subscriptionId).toBe(
        basic,
      );

      const enterprise = await addBundle(aliceId, { maxMessages: null, messagesUsed: 50_000 });
      expect((await ask(alice, { question: 'And now?' })).json<Chat>().subscriptionId).toBe(
        enterprise,
      );
      expect(await messagesUsed(enterprise)).toBe(50_001);
    });

    it('answers 402 QUOTA_EXHAUSTED and stores nothing when no quota is left', async () => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      await setFreeUsed(aliceId, 3);
      await addBundle(aliceId, { messagesUsed: 10 });

      const response = await ask(alice, { question: 'Anything left?' });

      expect(response.statusCode).toBe(402);
      expect(response.json()).toMatchObject({
        error: {
          code: 'QUOTA_EXHAUSTED',
          details: { freeLimit: 3, freeResetsAt: '2026-11-01T00:00:00.000Z' },
        },
      });
      expect(await chatCount()).toBe(0);
      expect(await usageRow(aliceId)).toEqual({ free_used: 3, total_used: 3 });
    });

    it.each([
      ['a user id', { userId: '00000000-0000-4000-8000-000000000000' }],
      ['an answer', { answer: 'forged' }],
      ['token counts', { promptTokens: 0, totalTokens: 0 }],
      ['a model', { model: 'gpt-5' }],
      ['a quota source', { quotaSource: 'subscription' }],
      ['a subscription id', { subscriptionId: '00000000-0000-4000-8000-000000000000' }],
      ['a timestamp', { createdAt: '2020-01-01T00:00:00.000Z' }],
      ['a request id', { requestId: 'forged' }],
    ])('rejects a body that supplies %s', async (_label, extra) => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);

      const response = await ask(alice, { question: 'Hi', ...extra });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(await chatCount()).toBe(0);
      expect(await usageRow(aliceId)).toEqual({ free_used: 0, total_used: 0 });
    });

    it.each([
      ['missing', {}],
      ['not a string', { question: 42 }],
      ['null', { question: null }],
      ['empty', { question: '' }],
      ['only whitespace', { question: '   \n\t ' }],
      ['only markup', { question: '<b></b><img src=x onerror=alert(1)>' }],
      ['longer than 2000 characters', { question: `<script>${'x'.repeat(2_001)}` }],
    ])('rejects a question that is %s, without echoing it', async (_label, body) => {
      await start();
      const alice = await login(idp, 'alice');

      const response = await ask(alice, body);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(response.body).not.toContain('<script>');
      expect(response.body).not.toContain('onerror');
      expect(await chatCount()).toBe(0);
    });

    it('stores questions as plain text: tags and control characters are removed', async () => {
      await start();
      const alice = await login(idp, 'alice');

      const tagged = await ask(alice, {
        question: '<script>alert(1)</script>What is <b>DPoP</b>?\u0000\u0007\r\nSecond line',
      });
      const comparison = await ask(alice, { question: 'Is 2 < 3 and 5 > 4?' });

      expect(tagged.json<Chat>().question).toBe('alert(1)What is DPoP?\nSecond line');
      expect(comparison.json<Chat>().question).toBe('Is 2 < 3 and 5 > 4?');
    });
  });

  describe('AI behaviour', () => {
    it('waits for the configured AI latency', async () => {
      await start({ env: { AI_MOCK_LATENCY_MS: '150' } });
      const alice = await login(idp, 'alice');
      await userId(alice);

      const started = Date.now();
      const response = await ask(alice, { question: 'Slow?' });

      expect(response.statusCode).toBe(201);
      expect(Date.now() - started).toBeGreaterThanOrEqual(145);
    });

    it('refunds the quota and stores nothing when the AI fails, without leaking details', async () => {
      await start({ env: { AI_MOCK_FAILURE_RATE: '1' } });
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      await setFreeUsed(aliceId, 3);
      const basic = await addBundle(aliceId, { messagesUsed: 4 });

      const response = await ask(alice, { question: 'Will this fail?' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: 'AI_UNAVAILABLE', message: 'The AI service is unavailable, retry later' },
        requestId: response.headers['x-request-id'],
      });
      expect(response.body).not.toMatch(/mock|stack|Error/);
      expect(await messagesUsed(basic)).toBe(4);
      expect(await usageRow(aliceId)).toEqual({ free_used: 3, total_used: 3 });
      expect(await chatCount()).toBe(0);
    });

    it('aborts the AI call on timeout, refunds the quota and stores nothing', async () => {
      await start({ env: { REQUEST_TIMEOUT_MS: '200', AI_MOCK_LATENCY_MS: '10000' } });
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);

      const started = Date.now();
      const response = await ask(alice, { question: 'Too slow?' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'REQUEST_TIMEOUT' } });
      expect(Date.now() - started).toBeLessThan(2_000);
      // The refund runs once the aborted AI call unwinds, just after the 503 is sent.
      await eventually(async () => (await usageRow(aliceId)).free_used === 0);
      expect(await chatCount()).toBe(0);
    });

    // inject() can't show socket-level behaviour: on a real connection Node emits the
    // request 'close' event as soon as the body is read, which must not count as an abort.
    async function postOverHttp(session: Session, question: string): Promise<Response> {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const proof = await createDpopProof(session.key, {
        method: 'POST',
        url: `${BASE_URL}/chat/messages`,
        accessToken: session.token,
      });
      return fetch(`${address}/chat/messages`, {
        method: 'POST',
        headers: {
          authorization: `DPoP ${session.token}`,
          dpop: proof,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ question }),
      });
    }

    it('completes over a real HTTP connection without aborting the AI call early', async () => {
      await start({ env: { AI_MOCK_LATENCY_MS: '100' } });

      const response = await postOverHttp(await login(idp, 'alice'), 'Over the wire?');

      expect(response.status).toBe(201);
      expect(await chatCount()).toBe(1);
    });

    it('still times out over a real HTTP connection and refunds the quota', async () => {
      await start({ env: { REQUEST_TIMEOUT_MS: '200', AI_MOCK_LATENCY_MS: '10000' } });
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);

      const started = Date.now();
      const response = await postOverHttp(alice, 'Too slow over the wire?');

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'REQUEST_TIMEOUT' } });
      expect(Date.now() - started).toBeLessThan(2_000);
      await eventually(async () => (await usageRow(aliceId)).free_used === 0);
      expect(await chatCount()).toBe(0);
    });
  });

  describe('concurrency', () => {
    it('never grants more than the 3 free messages to parallel requests', async () => {
      await start({ env: { AI_MOCK_LATENCY_MS: '20' } });
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);

      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => ask(alice, { question: `Parallel ${i}` })),
      );

      const codes = responses.map((response) => response.statusCode).sort();
      expect(codes).toEqual([201, 201, 201, 402, 402, 402, 402, 402, 402, 402]);
      expect(await chatCount(aliceId)).toBe(3);
      expect(await usageRow(aliceId)).toEqual({ free_used: 3, total_used: 3 });
    });

    it('never lets parallel requests push a subscription past maxMessages', async () => {
      await start({ env: { AI_MOCK_LATENCY_MS: '20' } });
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      await setFreeUsed(aliceId, 3);
      const basic = await addBundle(aliceId, { maxMessages: 10 });

      const responses = await Promise.all(
        Array.from({ length: 14 }, (_, i) => ask(alice, { question: `Parallel ${i}` })),
      );

      expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(10);
      expect(responses.filter((response) => response.statusCode === 402)).toHaveLength(4);
      expect(await messagesUsed(basic)).toBe(10);
      expect(await chatCount(aliceId)).toBe(10);
    });
  });

  describe('GET /chat/messages', () => {
    async function seed() {
      const alice = await login(idp, 'alice');
      const bob = await login(idp, 'bob');
      const ids = { alice: await userId(alice), bob: await userId(bob) };
      await ask(alice, { question: 'Alice one' });
      await ask(alice, { question: 'Alice two' });
      await ask(bob, { question: 'Bob one' });
      return { alice, bob, ids };
    }

    const list = async (session: Session, query = '') =>
      call(app, session, 'GET', `/chat/messages${query}`);

    it('shows users only their own chats, with explicit fields', async () => {
      await start();
      const { alice, ids } = await seed();

      const items = (await list(alice)).json<{ items: Chat[] }>().items;

      expect(items.map((item) => item.question).sort()).toEqual(['Alice one', 'Alice two']);
      expect(items.every((item) => item.userId === ids.alice)).toBe(true);
      expect(Object.keys(items[0]!).sort()).toEqual([
        'answer',
        'createdAt',
        'id',
        'question',
        'quotaSource',
        'requestId',
        'subscriptionId',
        'tokens',
        'userId',
      ]);
    });

    it('answers 403 when a normal user asks for another user’s chats', async () => {
      await start();
      const { alice, ids } = await seed();

      expect((await list(alice, `?userId=${ids.bob}`)).statusCode).toBe(403);
      expect((await list(alice, `?userId=${ids.alice}`)).statusCode).toBe(200);
    });

    it('lets an admin read one user’s chats, or everyone’s', async () => {
      await start();
      const { ids } = await seed();
      const admin = await login(idp, 'root', ['user', 'admin']);

      const forBob = (await list(admin, `?userId=${ids.bob}`)).json<{ items: Chat[] }>().items;
      const all = (await list(admin)).json<{ items: Chat[] }>().items;

      expect(forBob.map((item) => item.question)).toEqual(['Bob one']);
      expect(all).toHaveLength(3);
    });

    it('paginates newest first', async () => {
      await start();
      const alice = await login(idp, 'alice');
      await addBundle(await userId(alice), { maxMessages: null });
      for (let i = 1; i <= 5; i++) {
        clock = days(i / 24);
        await ask(alice, { question: `Message ${i}` });
      }

      const page = async (query: string) =>
        (await list(alice, query)).json<{ items: Chat[] }>().items.map((item) => item.question);

      expect(await page('?limit=2')).toEqual(['Message 5', 'Message 4']);
      expect(await page('?limit=2&offset=2')).toEqual(['Message 3', 'Message 2']);
      expect(await page('?limit=2&offset=4')).toEqual(['Message 1']);
    });

    it.each(['?sort=asc', '?limit=0', '?limit=101', '?offset=-1', '?limit=abc', '?userId=bob'])(
      'rejects the query %s',
      async (query) => {
        await start();
        const response = await list(await login(idp, 'alice'), query);
        expect(response.statusCode).toBe(400);
      },
    );
  });

  describe('GET /chat/usage', () => {
    const usage = async (session: Session) =>
      (await call(app, session, 'GET', '/chat/usage')).json<Record<string, unknown>>();

    it('reports the current UTC month for a new user', async () => {
      await start();
      expect(await usage(await login(idp, 'alice'))).toEqual({
        month: '2026-10',
        free: { limit: 3, used: 0, remaining: 3, resetsAt: '2026-11-01T00:00:00.000Z' },
        totalUsed: 0,
        subscriptions: [],
      });
    });

    it('reflects free and subscription usage, listing only usable subscriptions', async () => {
      await start();
      const alice = await login(idp, 'alice');
      const aliceId = await userId(alice);
      const basic = await addBundle(aliceId, { messagesUsed: 4 });
      const enterprise = await addBundle(aliceId, { maxMessages: null, messagesUsed: 7 });
      await addBundle(aliceId, { status: 'inactive' });
      await addBundle(aliceId, { end: days(-1) });
      await ask(alice, { question: 'One' });
      await ask(alice, { question: 'Two' });

      const result = await usage(alice);

      expect(result).toMatchObject({ free: { used: 2, remaining: 1 }, totalUsed: 2 });
      expect(result['subscriptions']).toEqual(
        expect.arrayContaining([
          {
            id: basic,
            tier: 'basic',
            maxMessages: 10,
            messagesUsed: 4,
            remaining: 6,
            endDate: days(20).toISOString(),
          },
          {
            id: enterprise,
            tier: 'enterprise',
            maxMessages: null,
            messagesUsed: 7,
            remaining: null,
            endDate: days(20).toISOString(),
          },
        ]),
      );
      expect(result['subscriptions']).toHaveLength(2);
    });

    it('does not count last month’s free usage', async () => {
      await start();
      const alice = await login(idp, 'alice');
      await setFreeUsed(await userId(alice), 3, '2026-09-01');

      expect(await usage(alice)).toMatchObject({ free: { used: 0, remaining: 3 }, totalUsed: 0 });
      expect((await ask(alice, { question: 'New month?' })).json<Chat>().quotaSource).toBe('free');
    });

    it('rejects query parameters', async () => {
      await start();
      const response = await call(
        app,
        await login(idp, 'alice'),
        'GET',
        '/chat/usage?month=2026-09',
      );
      expect(response.statusCode).toBe(400);
    });
  });

  describe('security', () => {
    it.each([
      ['POST', '/chat/messages'],
      ['GET', '/chat/messages'],
      ['GET', '/chat/usage'],
    ] as const)('%s %s requires OIDC + DPoP authentication', async (method, url) => {
      await start();
      const { token } = await login(idp, 'alice');

      const anonymous = await app.inject({ method, url, payload: { question: 'Hi' } });
      const bearerOnly = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        payload: { question: 'Hi' },
      });

      expect(anonymous.statusCode).toBe(401);
      expect(bearerOnly.statusCode).toBe(401);
      expect(await chatCount()).toBe(0);
    });
  });
});
