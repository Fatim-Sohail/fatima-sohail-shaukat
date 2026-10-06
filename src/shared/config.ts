import { z } from 'zod';

/** Only asymmetric algorithms are accepted; HS* and "none" enable key-confusion attacks. */
const ASYMMETRIC_JWT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
] as const;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const positiveInt = z.coerce.number().int().positive();

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * An exact origin (scheme + host + optional port), e.g. "https://app.example.com".
 * Zod 4 runs refinements even after the URL check fails, so unparseable values
 * are left to the URL check's own issue.
 */
const origin = httpUrl.refine((value) => !URL.canParse(value) || new URL(value).origin === value, {
  message: 'must be an exact origin without path, query or trailing slash',
});

function commaSeparated<T extends z.ZodType<unknown, string>>(item: T) {
  return z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item));
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: positiveInt.max(65_535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    TRUST_PROXY: z.stringbool().default(false),
    // Origin clients use to reach the API; DPoP proofs are checked against it (never the Host header).
    PUBLIC_BASE_URL: origin.default('http://localhost:3000'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    CORS_ALLOWED_ORIGINS: commaSeparated(origin).default([]),
    REQUEST_BODY_LIMIT_BYTES: positiveInt.max(1_048_576).default(16_384),
    REQUEST_TIMEOUT_MS: positiveInt.max(60_000).default(10_000),
    HEALTH_CHECK_TOKEN: z.string().min(32),

    OIDC_ISSUER: httpUrl,
    OIDC_AUDIENCE: z.string().min(1),
    OIDC_JWKS_URI: httpUrl,
    OIDC_ALGORITHMS: commaSeparated(z.enum(ASYMMETRIC_JWT_ALGORITHMS))
      .refine((algorithms) => algorithms.length > 0, 'must list at least one algorithm')
      .default(['RS256']),
    OIDC_ROLES_CLAIM: z.string().min(1).default('roles'),
    DPOP_PROOF_MAX_AGE_SECONDS: positiveInt.max(300).default(60),

    RATE_LIMIT_WINDOW_MS: positiveInt.default(60_000),
    RATE_LIMIT_IP_MAX: positiveInt.default(300),
    RATE_LIMIT_AUTH_MAX: positiveInt.default(20),
    RATE_LIMIT_CHAT_MAX: positiveInt.default(30),
    RATE_LIMIT_SUBSCRIPTION_MAX: positiveInt.default(60),

    AI_MOCK_LATENCY_MS: z.coerce.number().int().min(0).max(30_000).default(800),
    AI_MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
    PAYMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.1),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') {
      return;
    }
    const mustBeHttps: [string, string][] = [
      ['PUBLIC_BASE_URL', env.PUBLIC_BASE_URL],
      ['OIDC_ISSUER', env.OIDC_ISSUER],
      ['OIDC_JWKS_URI', env.OIDC_JWKS_URI],
      ...env.CORS_ALLOWED_ORIGINS.map((value, index): [string, string] => [
        `CORS_ALLOWED_ORIGINS.${index}`,
        value,
      ]),
    ];
    for (const [path, value] of mustBeHttps) {
      if (!value.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [path], message: 'must use https in production' });
      }
    }
  });

export type Config = Readonly<z.infer<typeof envSchema>>;

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Validates environment variables once at startup and fails fast.
 * Empty strings are treated as unset. Error messages name the offending
 * variable but never echo its value, so secrets cannot leak into logs.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const provided = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = envSchema.safeParse(provided);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`),
    );
  }
  return Object.freeze(result.data);
}
