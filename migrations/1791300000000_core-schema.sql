-- Up Migration

-- Enumerations are TEXT + CHECK rather than ENUM types: same integrity, simpler to evolve.
-- Foreign keys use the default NO ACTION so history (chats, payments) can never be cascaded away.

CREATE TABLE users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- OIDC guarantees `sub` is unique per issuer, so identity is the (issuer, subject) pair.
  idp_issuer   text        NOT NULL CHECK (length(idp_issuer) BETWEEN 1 AND 512),
  idp_subject  text        NOT NULL CHECK (length(idp_subject) BETWEEN 1 AND 255),
  email        text        CHECK (length(email) <= 320),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_identity_unique UNIQUE (idp_issuer, idp_subject)
);

CREATE TABLE subscriptions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES users (id),
  tier           text        NOT NULL CHECK (tier IN ('basic', 'pro', 'enterprise')),
  billing_cycle  text        NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  -- NULL means unlimited, which is exactly the enterprise tier.
  max_messages   integer     CHECK (max_messages > 0),
  messages_used  integer     NOT NULL DEFAULT 0 CHECK (messages_used >= 0),
  price_cents    integer     NOT NULL CHECK (price_cents >= 0),
  auto_renew     boolean     NOT NULL,
  status         text        NOT NULL CHECK (status IN ('active', 'inactive')),
  start_date     timestamptz NOT NULL,
  end_date       timestamptz NOT NULL,
  renewal_date   timestamptz,
  cancelled_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_unlimited_iff_enterprise CHECK ((tier = 'enterprise') = (max_messages IS NULL)),
  CONSTRAINT subscriptions_usage_within_limit CHECK (max_messages IS NULL OR messages_used <= max_messages),
  CONSTRAINT subscriptions_period_valid CHECK (end_date > start_date),
  CONSTRAINT subscriptions_renewal_requires_auto_renew CHECK (renewal_date IS NULL OR auto_renew),
  CONSTRAINT subscriptions_cancelled_not_renewing CHECK (cancelled_at IS NULL OR NOT auto_renew)
);

CREATE INDEX subscriptions_user_status_idx ON subscriptions (user_id, status);
CREATE INDEX subscriptions_renewal_due_idx ON subscriptions (renewal_date)
  WHERE status = 'active' AND auto_renew;

CREATE TABLE payments (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid        NOT NULL REFERENCES subscriptions (id),
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  status           text        NOT NULL CHECK (status IN ('succeeded', 'failed')),
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_period_valid CHECK (period_end > period_start)
);

CREATE INDEX payments_subscription_idx ON payments (subscription_id, created_at DESC);

-- One row per user per calendar month: a new month starts a new row, which is the free-quota reset.
CREATE TABLE monthly_usage (
  user_id     uuid    NOT NULL REFERENCES users (id),
  period      date    NOT NULL CHECK (extract(day FROM period) = 1),
  free_used   integer NOT NULL DEFAULT 0 CHECK (free_used BETWEEN 0 AND 3),
  total_used  integer NOT NULL DEFAULT 0 CHECK (total_used >= free_used),
  PRIMARY KEY (user_id, period)
);

CREATE TABLE chat_messages (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES users (id),
  question           text        NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  answer             text        NOT NULL,
  model              text        NOT NULL,
  prompt_tokens      integer     NOT NULL CHECK (prompt_tokens >= 0),
  completion_tokens  integer     NOT NULL CHECK (completion_tokens >= 0),
  total_tokens       integer     NOT NULL,
  quota_source       text        NOT NULL CHECK (quota_source IN ('free', 'subscription')),
  subscription_id    uuid        REFERENCES subscriptions (id),
  request_id         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_total_tokens CHECK (total_tokens = prompt_tokens + completion_tokens),
  CONSTRAINT chat_messages_source_matches_subscription
    CHECK ((quota_source = 'subscription') = (subscription_id IS NOT NULL))
);

CREATE INDEX chat_messages_user_created_idx ON chat_messages (user_id, created_at DESC);
CREATE INDEX chat_messages_subscription_idx ON chat_messages (subscription_id)
  WHERE subscription_id IS NOT NULL;

-- DPoP proof identifiers already seen, kept until the proof could no longer be accepted.
CREATE TABLE dpop_replay (
  jti         text        PRIMARY KEY CHECK (length(jti) BETWEEN 1 AND 255),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX dpop_replay_expires_idx ON dpop_replay (expires_at);

-- Binds an access token (by hash) to the first DPoP key it was presented with.
CREATE TABLE token_bindings (
  token_hash  text        PRIMARY KEY CHECK (length(token_hash) BETWEEN 32 AND 128),
  jkt         text        NOT NULL CHECK (length(jkt) BETWEEN 1 AND 128),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX token_bindings_expires_idx ON token_bindings (expires_at);

-- Down Migration

DROP TABLE token_bindings;
DROP TABLE dpop_replay;
DROP TABLE chat_messages;
DROP TABLE monthly_usage;
DROP TABLE payments;
DROP TABLE subscriptions;
DROP TABLE users;
