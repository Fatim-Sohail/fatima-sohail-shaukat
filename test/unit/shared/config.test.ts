import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../../src/shared/config.js';

const validEnv = {
  DATABASE_URL: 'postgres://ggi:secret@localhost:5432/ggi',
  HEALTH_CHECK_TOKEN: 'h'.repeat(32),
  OIDC_ISSUER: 'https://idp.example.com/realms/ggi',
  OIDC_AUDIENCE: 'ggi-api',
  OIDC_JWKS_URI: 'https://idp.example.com/realms/ggi/protocol/openid-connect/certs',
};

function configErrorFor(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}

describe('loadConfig', () => {
  it('applies secure defaults for optional variables', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 3000,
      TRUST_PROXY: false,
      CORS_ALLOWED_ORIGINS: [],
      REQUEST_BODY_LIMIT_BYTES: 16_384,
      OIDC_ALGORITHMS: ['RS256'],
      OIDC_ROLES_CLAIM: 'roles',
    });
  });

  it('coerces numbers, booleans and comma-separated lists', () => {
    const config = loadConfig({
      ...validEnv,
      PORT: '8080',
      TRUST_PROXY: 'true',
      PAYMENT_FAILURE_RATE: '0.25',
      CORS_ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:5173',
      OIDC_ALGORITHMS: 'RS256,ES256',
    });

    expect(config.PORT).toBe(8080);
    expect(config.TRUST_PROXY).toBe(true);
    expect(config.PAYMENT_FAILURE_RATE).toBe(0.25);
    expect(config.CORS_ALLOWED_ORIGINS).toEqual([
      'https://app.example.com',
      'http://localhost:5173',
    ]);
    expect(config.OIDC_ALGORITHMS).toEqual(['RS256', 'ES256']);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...validEnv, PORT: '' }).PORT).toBe(3000);
    expect(configErrorFor({ ...validEnv, DATABASE_URL: '  ' }).message).toContain('DATABASE_URL');
  });

  it('reports every missing required variable', () => {
    const error = configErrorFor({});

    for (const key of Object.keys(validEnv)) {
      expect(error.message).toContain(key);
    }
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(
      configErrorFor({ ...validEnv, DATABASE_URL: 'mysql://u:p@localhost/db' }).message,
    ).toContain('DATABASE_URL');
  });

  it.each(['HS256', 'none', 'RS256,HS512'])(
    'rejects non-asymmetric JWT algorithm list %s',
    (algs) => {
      expect(configErrorFor({ ...validEnv, OIDC_ALGORITHMS: algs }).message).toContain(
        'OIDC_ALGORITHMS',
      );
    },
  );

  it.each(['*', 'https://app.example.com/', 'https://app.example.com/path', 'ftp://example.com'])(
    'rejects CORS origin %s',
    (value) => {
      expect(configErrorFor({ ...validEnv, CORS_ALLOWED_ORIGINS: value }).message).toContain(
        'CORS_ALLOWED_ORIGINS',
      );
    },
  );

  it('rejects a weak health check token', () => {
    expect(configErrorFor({ ...validEnv, HEALTH_CHECK_TOKEN: 'short' }).message).toContain(
      'HEALTH_CHECK_TOKEN',
    );
  });

  it.each([
    ['PORT', '70000'],
    ['PORT', 'abc'],
    ['TRUST_PROXY', 'maybe'],
    ['PAYMENT_FAILURE_RATE', '1.5'],
    ['REQUEST_TIMEOUT_MS', '0'],
  ])('rejects out-of-range %s=%s', (key, value) => {
    expect(configErrorFor({ ...validEnv, [key]: value }).message).toContain(key);
  });

  it('requires https for OIDC endpoints and CORS origins in production', () => {
    const error = configErrorFor({
      ...validEnv,
      NODE_ENV: 'production',
      OIDC_ISSUER: 'http://idp.example.com',
      OIDC_JWKS_URI: 'http://idp.example.com/jwks',
      CORS_ALLOWED_ORIGINS: 'http://app.example.com',
    });

    expect(error.issues).toEqual([
      'OIDC_ISSUER: must use https in production',
      'OIDC_JWKS_URI: must use https in production',
      'CORS_ALLOWED_ORIGINS.0: must use https in production',
    ]);
  });

  it('never echoes variable values in error messages', () => {
    const error = configErrorFor({
      ...validEnv,
      DATABASE_URL: 'mysql://admin:supersecretpassword@db/ggi',
      HEALTH_CHECK_TOKEN: 'leakyvalue',
    });

    expect(error.message).not.toContain('supersecretpassword');
    expect(error.message).not.toContain('leakyvalue');
  });

  it('returns an immutable config object', () => {
    expect(Object.isFrozen(loadConfig(validEnv))).toBe(true);
  });
});
