# GGI Backend Assessment

A secure backend for an AI chat service with monthly free quota and paid subscription bundles.
TypeScript (strict), Fastify, PostgreSQL, Clean Architecture / DDD-style modules.

- **Chat:** users ask questions and get a mocked OpenAI answer. Every chat is stored with its token usage.
- **Quota:** each user gets 3 free messages per calendar month, then needs a subscription bundle (Basic 10, Pro 100, Enterprise unlimited).
- **Subscriptions:** monthly or yearly billing, auto-renew, cancellation, and simulated payments with random failures.
- **Security:** OIDC access tokens must be paired with a DPoP proof of possession. Access is controlled by role (RBAC) and by ownership; per-IP and per-user rate limits apply.

The assessment specification is in [`docs/GGI - BACKEND TEST POSTURE.pdf`](docs/GGI%20-%20BACKEND%20TEST%20POSTURE.pdf).

---

## Quick start

Requirements: Node.js ≥ 22.9, Docker.

```bash
npm install
cp .env.example .env                 # then adjust (see Configuration)
docker compose up -d --wait          # PostgreSQL 17 with databases ggi and ggi_test
npm run db:migrate                   # applies migrations to DATABASE_URL
npm test                             # unit + integration tests (needs the database)
npm run dev                          # http://localhost:3000
```

If port 5432 is already used locally, set `POSTGRES_PORT=5433` in `.env` and point `DATABASE_URL` and `TEST_DATABASE_URL` at that port.

The server starts with the placeholder OIDC values, but authenticated routes only accept tokens from a real provider configured in `.env`. The test suite needs no provider: it runs against a bundled mock provider.

| Command                              | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `npm run dev` / `npm start`          | Run with tsx (watch) / run the compiled build               |
| `npm run build`                      | Compile to `dist/`                                          |
| `npm run lint`                       | ESLint (`--max-warnings=0`) and Prettier check              |
| `npm run typecheck`                  | `tsc --noEmit`                                              |
| `npm test`                           | All tests; `test:unit` / `test:integration` run one project |
| `npm run db:migrate` / `db:rollback` | node-pg-migrate up / down                                   |
| `npm run check`                      | lint + typecheck + test                                     |

---

## Stack

| Concern            | Choice                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| Runtime / language | Node.js, TypeScript `strict` + `noUncheckedIndexedAccess`, ESM                        |
| HTTP               | Fastify 5, `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`                  |
| Validation         | zod (`strictObject` everywhere)                                                       |
| Tokens / DPoP      | jose                                                                                  |
| Database           | PostgreSQL 17, `pg` with parameterized SQL (no ORM), node-pg-migrate (SQL migrations) |
| Tests              | Vitest: a unit project and an integration project against a real PostgreSQL           |
| Quality            | ESLint (typescript-eslint strict, type-checked) and Prettier                          |

---

## Architecture

```
src/
  app.ts                  buildApp(): wires everything, used by server and tests
  server.ts               process entry: config, pool, listen, graceful shutdown
  shared/
    config.ts             env validation (zod), fails fast
    errors.ts             AppError(kind, code, message, details): transport-agnostic
    auth/                 access-token verifier, DPoP verifier, principal + policies, user provisioning
    db/                   pool, withTransaction
    http/                 security plugins, auth hook + RBAC guard, error handler, logging, /health, /auth/me
  modules/
    subscriptions/
      domain/{entities,services,policies}   tiers, periods, lifecycle, billing, payment port, ownership
      application/                          use cases (subscribe, cancel, runBilling, ...)
      repositories/                         SQL
      infrastructure/                       mock payment gateway
      controllers/                          routes + zod schemas + response mapping
    chat/
      domain/{entities,services,policies}   ChatMessage, plain-text rule, quota decision, AI port
      application/                          reserve/refund quota, ask flow, history, usage
      repositories/                         SQL
      infrastructure/                       mock AI provider
      controllers/
    metrics/                                admin metrics (repository + route)
migrations/               SQL schema
test/unit, test/integration, test/helpers (mock OIDC provider, DPoP client, sessions)
```

**Layer rules, enforced by ESLint and covered by a test:**

- `domain/**` may not import Fastify, `pg`, jose, zod or any outer layer.
- `application/**` may not import the HTTP layer.
- Domain code describes failures with an error _kind_ (`conflict`, `payment_required`, …), and only the HTTP error handler maps kinds to status codes.

**Notable decisions:**

- **Explicit SQL instead of an ORM:** row locks (`FOR UPDATE`, `SKIP LOCKED`) and conditional updates are what make quota and billing safe, so they are written out where a reviewer can see them.
- **Pure domain functions:** domain transitions take the current time (`now`) as input and don't mutate their arguments. Randomness (payment and AI failures) lives only in infrastructure mocks and is injectable.
- **Explicit response mapping:** each module maps entities to responses field by field, so database-only columns never leak.

---

## Security model

### Authentication: OIDC access tokens (provider-agnostic)

- **External provider:** identity comes from an external OAuth2/OIDC provider, configured only through `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, `OIDC_ALGORITHMS` and `OIDC_ROLES_CLAIM`.
  - Email/password and social login (e.g. Google, GitHub) are provider features; this service never handles passwords.
  - No provider is deployed in this repository (see Deferred).
  - Keycloak example: issuer `https://<host>/realms/<realm>`, JWKS `…/protocol/openid-connect/certs`, roles claim `realm_access.roles`.
  - Auth0 example: add an `admin` role to a namespaced claim and set `OIDC_ROLES_CLAIM` to that claim name.
- **Token verification** (jose, `shared/auth/accessToken.ts`):
  - Signature checked against the provider's JWKS, fetched over HTTP and cached.
  - **Algorithm pinned** to the configured asymmetric list; `HS*` and `none` are rejected, including in config.
  - `iss` and `aud` must match.
  - `exp` and `sub` are **required**; `nbf` is checked when present; 5 s clock tolerance.
  - The roles claim is read by exact name or dot-path. A malformed roles or `cnf` claim rejects the token rather than being ignored.
- **Errors:** an invalid token gives 401 `INVALID_TOKEN` with a generic message; the detailed reason is only logged. An unreachable JWKS gives 503 `AUTH_PROVIDER_UNAVAILABLE`, not 401.

### Proof of possession: DPoP (RFC 9449)

A token alone is not enough. Every request must send `Authorization: DPoP <access-token>` **and** a `DPoP: <proof>` header (`shared/auth/dpop.ts`).

- **Proof checks:**
  - `typ` is `dpop+jwt`, with an asymmetric `alg` only.
  - Signed by the public key embedded in its own header; proofs that embed a private key are rejected.
  - `htm` must equal the HTTP method.
  - `htu` must equal `PUBLIC_BASE_URL` + path, normalized, with query and fragment ignored. The URL is **never** taken from `Host` or `X-Forwarded-*` headers.
  - `iat` must be within ±`DPOP_PROOF_MAX_AGE_SECONDS`.
  - `jti` must be present.
  - `ath` must equal base64url(SHA-256(access token)).
- **Replay protection:** each `jti` is inserted into `dpop_replay` in one atomic statement (`ON CONFLICT … DO UPDATE … WHERE expired`). Concurrent replays race on the primary key and only one wins. An expired record may be reused because its proof can no longer pass the `iat` check.
- **Key binding:**
  - If the token carries `cnf.jkt` (the provider issued a DPoP-bound token), the proof key's thumbprint must match it.
  - Otherwise the **first use** binds `sha256(token)` to the proof key in `token_bindings`, and every later request with that token must use the same key.
  - A stolen token presented with another key gets 401 `DPOP_KEY_MISMATCH`.
- **Failures** are generic 401s: `INVALID_DPOP_PROOF`, `DPOP_REPLAY` or `DPOP_KEY_MISMATCH`.

### Request pipeline (default-deny)

Every route registered after `registerAuthentication` automatically runs these steps unless it is marked `config.public`. Only `/health` is public, and it is protected by `X-Health-Token` instead.

```
per-IP rate limit → DPoP token extraction → OIDC verification → DPoP verification
  → find-or-create local user by (issuer, subject) → principal → per-user rate limit
```

- **Rate-limit group required:** a route without a rate-limit group fails at startup.
- **Unknown routes:** they are not authenticated but are IP rate-limited, and return 404.
- **Principal:** `{ userId, issuer, subject, roles }`, built only from the verified token and the local `users` row. User IDs, roles and other server-owned values are never read from request input.

### Authorization: RBAC and ownership

- **Two levels:**
  - Routes: `requireRole('admin')` guards admin routes.
  - Domain: policies (`assertAdmin`, `assertCanView`, `assertCanModify`, `assertCanList…`) are checked again behind the route guard, so a missing guard cannot open access (tested).
- **Ownership:**
  - Owners and admins can read a resource; anyone else gets **404**, indistinguishable from a resource that does not exist.
  - Only the owner can modify a subscription; an admin gets 403.
  - Listing another user's data (`?userId=`) requires admin, otherwise 403.

### HTTP hardening

- **Secure headers (helmet):** `CSP default-src 'none'; frame-ancestors 'none'`, HSTS, `nosniff`, and `Cache-Control: no-store` on every response.
- **CORS:** an exact-origin allowlist (`CORS_ALLOWED_ORIGINS`). Wildcards are rejected, credentials are off, and https is required in production.
- **Request bodies:**
  - Body limit of 16 KB (413).
  - **JSON only:** any other or missing content type gets 415; malformed JSON gets 400 without echoing the input.
- **Global request timeout:** a structured 503 `REQUEST_TIMEOUT`.
  - The same timer aborts `request.abortSignal`, which also fires on a real client disconnect. Fastify's own `request.signal` is not used because it also aborts once a request body has been read.
- **Error handling:** centralized, with one JSON shape `{ error: { code, message, details? }, requestId }`. No stack traces; parser and provider messages are never forwarded.
- **Logging:** one structured line per request (pino) with `requestId`, `userId` and `responseTimeMs`.
  - Client `X-Request-Id` values are accepted only if they match `[A-Za-z0-9._:-]{8,128}`.
  - `Authorization`, `DPoP`, `Cookie` and `X-Health-Token` are redacted.

### Rate limiting (in memory)

| Layer                 | Key       | Limit                                                                                                                     |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------- |
| Global                | client IP | `RATE_LIMIT_IP_MAX` per `RATE_LIMIT_WINDOW_MS`, runs **before** authentication, so unauthenticated floods are limited too |
| `auth` group          | user ID   | `RATE_LIMIT_AUTH_MAX` (`/auth/me`, `/metrics`)                                                                            |
| `chat` group          | user ID   | `RATE_LIMIT_CHAT_MAX`                                                                                                     |
| `subscriptions` group | user ID   | `RATE_LIMIT_SUBSCRIPTION_MAX` (incl. `/admin/billing/run`)                                                                |

Exceeding a limit gives 429 `RATE_LIMITED` with `Retry-After`. The per-user layer uses `createRateLimit()`, because handlers created with `app.rateLimit()` share a "has run" flag with the global limiter and would be skipped silently.

### Validation and mass assignment

- **Strict schemas:** every body, query and path parameter is parsed with a zod `strictObject`, so unknown fields give 400 `VALIDATION_FAILED`.
- **Server-owned fields can't be supplied:** price, `maxMessages`, status, usage, user ID, model, tokens, quota source and timestamps are all rejected by tests.
- **Server-side catalog:** prices and limits come only from the catalog, and domain constructors copy fields one by one rather than spreading input.
- **SQL:** all queries are parameterized.
- **XSS:** questions are plain text.
  - Tag-like markup and control characters (except newline and tab) are removed, at most 2000 characters, and the result must not be empty.
  - Responses are JSON-only under `CSP default-src 'none'`.
  - The mock answer never echoes the question.

---

## Quota rules

- **Free first:** 3 free messages per **UTC calendar month**, used before any subscription.
- **Bundle selection:** after the free quota, the next message is charged to the **usable bundle with the most messages left**.
  - Usable means active, and `startDate <= now < endDate`.
  - Enterprise counts as unlimited.
  - Ties go to the newest `startDate`.
  - Used-up, inactive, expired and not-yet-started bundles are skipped.
- **Exhausted:** with nothing left, the request gets 402 `QUOTA_EXHAUSTED` with `{ freeLimit, freeResetsAt }`.
- **Monthly reset:** free usage is stored in `monthly_usage` keyed by month, so a new month starts at 0 without a reset job.

The decision is the pure `decideQuota()` (`chat/domain/services/quota.ts`); it never deducts.

### Transactional reservation (concurrency-safe)

`chat/application/quota.ts`:

1. **Reserve.** One short transaction:
   1. Lock the user row (`FOR UPDATE`).
   2. Insert the month's `monthly_usage` row if missing, then lock it.
   3. Lock the usable bundles, ordered by id.
   4. Call `decideQuota()`.
   5. Apply a **conditional** increment (`… WHERE free_used < 3`, or `… WHERE messages_used < max_messages`). The schema's `CHECK` constraints are a final guard.
   6. Commit.
2. **AI call** outside any transaction, so no locks or connections are held during its latency.
3. **On AI failure, timeout or disconnect:** a separate short transaction refunds exactly that reservation. Counters never go below 0, and a bundle that renewed in the meantime is not refunded.

Locks are always taken in the same order (user, then usage, then bundles by id); billing locks only subscription rows. Parallel-request tests (10 free-quota requests and 14 on a 10-message bundle) prove exactly 3 and exactly 10 succeed. Each concurrency test was also checked to fail against a deliberately non-atomic variant.

---

## Subscriptions and billing

- **Catalog:**

  | Tier       | Messages  | Monthly | Yearly  |
  | ---------- | --------- | ------- | ------- |
  | Basic      | 10        | $9.99   | $99.90  |
  | Pro        | 100       | $29.99  | $299.90 |
  | Enterprise | unlimited | $99.99  | $999.90 |

- **Periods:** monthly or yearly, in UTC. Month-end dates clamp to the target month (Jan 31 + 1 month = Feb 28/29).
- **Fields:** `maxMessages`, `price`, `startDate`, `endDate`, `renewalDate` (set exactly when auto-renew is on), active/inactive `status`, `cancelledAt`.
- **Create:** the first period is charged through the `PaymentGateway`, then the subscription and payment row are stored in one transaction.
  - A declined payment gives 402 `PAYMENT_FAILED`; the attempt is stored as an **inactive** subscription with a `failed` payment row.
- **Cancel:** stops renewals; the subscription stays usable until `endDate`, and usage history is kept. Repeat cancels return the same result, and auto-renew cannot be turned back on afterwards.
- **Billing run (`POST /admin/billing/run`):** handles each due subscription in its own transaction.
  - Each is locked with `FOR UPDATE SKIP LOCKED`.
  - Auto-renew due: charge, then renew (new period, `messagesUsed` reset) or deactivate on payment failure.
  - Period over without auto-renew, or cancelled: expire, with no charge.
  - The row stays locked while it is charged, so parallel runs cannot bill it twice.
  - The charge's idempotency key (subscription ID + period start) prevents a second charge if a run crashed after charging.
  - Returns `{ renewed, failed, expired, errors }`.
- **Payments:** `PAYMENT_FAILURE_RATE` controls the random failure rate. The mock gateway remembers idempotency keys like a real provider. Payment rows are append-only history.

---

## Chat flow

`POST /chat/messages` with body `{ "question": "..." }`:

1. Authenticate, validate and sanitize the question.
2. Reserve quota (see above).
3. Call the mock AI with `request.abortSignal`.
   - Latency is `AI_MOCK_LATENCY_MS`, failures follow `AI_MOCK_FAILURE_RATE`, and token counts are derived from text length.
   - On failure: refund, then 503 `AI_UNAVAILABLE`.
   - On timeout: refund, then 503 `REQUEST_TIMEOUT`.
4. Store the chat in a short transaction: user, question, answer, model, prompt/completion/total tokens, quota source, subscription ID, request ID, timestamp.

A chat row exists only for a successful answer that was delivered.

---

## API

All routes except `/health` require `Authorization: DPoP <token>` and a `DPoP` proof.

| Method | Path                                 | Access           | Notes                                                                                     |
| ------ | ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/health`                            | `X-Health-Token` | `{ status, checks: { database } }`; 503 if the database is down                           |
| GET    | `/auth/me`                           | user             | `{ userId, issuer, subject, roles }` from verified auth                                   |
| POST   | `/chat/messages`                     | user             | 201 chat; 400 / 402 / 503 as above                                                        |
| GET    | `/chat/messages?limit&offset&userId` | user / admin     | Own history; admin: all, or `?userId=`. Non-admin `?userId=` for someone else gives 403   |
| GET    | `/chat/usage`                        | user             | Current UTC month: free used/remaining/reset, total, usable subscriptions                 |
| POST   | `/subscriptions`                     | user             | `{ tier, billingCycle, autoRenew }`; 201, or 402 `PAYMENT_FAILED`                         |
| GET    | `/subscriptions?limit&offset&userId` | user / admin     | Same listing rules as chats                                                               |
| GET    | `/subscriptions/:id`                 | owner / admin    | Others get 404                                                                            |
| PATCH  | `/subscriptions/:id`                 | owner            | `{ autoRenew }`; admin 403, others 404                                                    |
| POST   | `/subscriptions/:id/cancel`          | owner            | Idempotent                                                                                |
| POST   | `/admin/billing/run`                 | admin            | `{ renewed, failed, expired, errors }`                                                    |
| GET    | `/metrics`                           | admin            | Users, chats this UTC month, active subscriptions by tier, payment success/failure counts |

Error codes include:

- 400: `VALIDATION_FAILED`, `INVALID_JSON`
- 401: `MISSING_TOKEN`, `INVALID_TOKEN`, `INVALID_DPOP_PROOF`, `DPOP_REPLAY`, `DPOP_KEY_MISMATCH`, `UNAUTHORIZED` (health token)
- 402: `QUOTA_EXHAUSTED`, `PAYMENT_FAILED`
- 403: `FORBIDDEN`
- 404: `NOT_FOUND`
- 409: `SUBSCRIPTION_CANCELLED`, `SUBSCRIPTION_INACTIVE`
- 413, 415
- 429: `RATE_LIMITED`
- 503: `REQUEST_TIMEOUT`, `AI_UNAVAILABLE`, `PAYMENT_UNAVAILABLE`, `AUTH_PROVIDER_UNAVAILABLE`, `SERVICE_UNAVAILABLE`

---

## Configuration

All variables are validated at startup (`src/shared/config.ts`); see `.env.example`. Errors name the variable but never echo its value.

| Variable                                                                                                                 | Default                            | Notes                                                                |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------- |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`                                                                                  | development, 127.0.0.1, 3000, info |                                                                      |
| `TRUST_PROXY`                                                                                                            | false                              | Only behind a trusted proxy (affects client IP)                      |
| `PUBLIC_BASE_URL`                                                                                                        | http://localhost:3000              | Origin used for DPoP `htu`; must be https in production              |
| `DATABASE_URL`                                                                                                           | required                           | `postgres://…`                                                       |
| `TEST_DATABASE_URL`                                                                                                      | …/ggi_test                         | Tests only; the name must end in `_test` (it is dropped and rebuilt) |
| `CORS_ALLOWED_ORIGINS`                                                                                                   | empty                              | Comma-separated exact origins                                        |
| `REQUEST_BODY_LIMIT_BYTES`, `REQUEST_TIMEOUT_MS`                                                                         | 16384, 10000                       |                                                                      |
| `HEALTH_CHECK_TOKEN`                                                                                                     | required                           | ≥ 32 characters                                                      |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`                                                                          | required                           | https in production                                                  |
| `OIDC_ALGORITHMS`, `OIDC_ROLES_CLAIM`                                                                                    | RS256, roles                       | Asymmetric algorithms only; claim name or dot-path                   |
| `DPOP_PROOF_MAX_AGE_SECONDS`                                                                                             | 60                                 |                                                                      |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_IP_MAX`, `RATE_LIMIT_AUTH_MAX`, `RATE_LIMIT_CHAT_MAX`, `RATE_LIMIT_SUBSCRIPTION_MAX` | 60000, 300, 20, 30, 60             |                                                                      |
| `AI_MOCK_LATENCY_MS`, `AI_MOCK_FAILURE_RATE`, `PAYMENT_FAILURE_RATE`                                                     | 800, 0, 0.1                        | Simulations                                                          |

---

## Database

- **Docker:** `docker-compose.yml` runs PostgreSQL 17 bound to `127.0.0.1` only, and an init script creates `ggi_test`.
- **Migrations:** plain SQL in `migrations/` with up and down sections (`npm run db:migrate`, `npm run db:rollback`).
- **Tables:**
  - `users`: unique on `(idp_issuer, idp_subject)`.
  - `subscriptions`: CHECKs on enterprise ⇔ `max_messages IS NULL`, usage ≤ limit, valid period, renewal ⇒ auto-renew, cancelled ⇒ not renewing.
  - `payments`.
  - `monthly_usage`: primary key `(user_id, period)`; first-of-month period; `free_used ≤ 3`.
  - `chat_messages`: token totals consistent; source ⇔ subscription ID.
  - `dpop_replay`, `token_bindings`.
- **Foreign keys never cascade deletes,** so history is kept.
- **Integration test setup:** every run drops and rebuilds the test schema and applies the migrations **up, down and up again**, so the down migration is exercised too.

---

## Testing

- **Unit tests:**
  - Config validation and layer-boundary lint rules.
  - Tier catalog and billing periods; subscription lifecycle and billing decisions.
  - Ownership policies, the quota decision, and the payment and AI mocks.
- **Integration tests (real PostgreSQL):**
  - Security middleware, error handling and logging, health.
  - Token verification and DPoP.
  - Authentication, provisioning, RBAC and rate limits.
  - Subscriptions and billing, quota reservation, chat, metrics.
- **The auth provider is mocked, not bypassed:** `test/helpers/mockIdp.ts` generates RSA keys, serves a real JWKS over HTTP and mints tokens. Every test goes through the production verifier and DPoP checks, with proofs signed by `test/helpers/dpopClient.ts`.
- **Real sockets:** some chat tests run over a real socket (`listen` + `fetch`) because in-process injection cannot show socket-level abort behaviour.

---

## Interpretation decisions

| Specification text                                           | Decision                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| "Bundle with the latest remaining quota"                     | Usable bundle with the **highest remaining** quota; newest `startDate` breaks ties                                               |
| "Free quota resets on the 1st"                               | UTC calendar month; usage rows are keyed by month, so no job is needed                                                           |
| "Possession of an access token alone must not be sufficient" | DPoP on every request: `cnf.jkt` when the provider binds tokens, otherwise first-use binding; plus `jti` replay and `iat` checks |
| "All endpoints must be protected"                            | Default-deny auth; `/health` uses a static probe token because probes have no user identity                                      |
| Cancellation "ends the current billing cycle"                | Usable until `endDate`, never renewed afterwards, history kept                                                                   |
| Initial purchase                                             | Charged at creation; a decline gives 402 and is recorded as an inactive subscription with a failed payment                       |
| Payment failure on renewal                                   | Subscription becomes inactive immediately; no retries                                                                            |
| "Automatically renew"                                        | Logic plus an admin-triggered run (`POST /admin/billing/run`); no scheduler (see Deferred)                                       |
| Admin access                                                 | Admins can read every user's chats and subscriptions (all by default, or `?userId=`); only owners can modify a subscription      |
| Unauthorized access to another user's resource               | 404 (existence hidden); 403 for role failures and explicit `?userId=` requests                                                   |
| XSS sanitization                                             | Questions are plain text (markup removed, max 2000 characters); JSON-only responses with a strict CSP                            |
| Prices                                                       | Placeholder amounts in the server-side catalog                                                                                   |

---

## Deferred / known limitations

| Item                                                                                           | Why                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Deploying an identity provider (Keycloak or Auth0 with email/password and Google/GitHub login) | The service is provider-agnostic and configured by env; tests use the mock provider                                      |
| Redis store for rate limits                                                                    | In-memory limits are correct for a single instance; multiple instances need a shared store                               |
| Scheduled billing worker                                                                       | Billing runs through the admin endpoint, within the request timeout; a cron job can call the same use case               |
| Cleanup of expired `dpop_replay` / `token_bindings` rows                                       | Correctness doesn't depend on it (expired replay rows are overwritten); it only limits table growth                      |
| Real payment provider and OpenAI                                                               | Mocked as required; a database failure after a successful first charge would need refund or reconciliation               |
| Crash between quota reservation and refund                                                     | That one message stays consumed; would need a reconciliation job or pending state                                        |
| Billing anchor day                                                                             | Renewals start from the previous end date, so Jan 31 → Feb 28 → Mar 28; keeping the 31st needs a stored anchor           |
| DPoP server nonce, `WWW-Authenticate: DPoP` header                                             | Freshness relies on the `iat` window and `jti` replay protection                                                         |
| First-use DPoP binding gap                                                                     | A token stolen before its first legitimate use could be bound by the thief; provider-bound (`cnf.jkt`) tokens close this |
| OpenAPI documentation, email on user records                                                   | Out of scope; access tokens don't reliably carry email                                                                   |
