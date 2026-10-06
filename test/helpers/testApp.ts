import { loadConfig, type Config } from '../../src/shared/config.js';
import { TEST_DATABASE_URL } from './testDatabase.js';

export const HEALTH_TOKEN = 'test-health-token-0123456789abcdef';
export const ALLOWED_ORIGIN = 'https://app.example.com';

/** Builds config through the real validator, so tests run with production-shaped settings. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    HEALTH_CHECK_TOKEN: HEALTH_TOKEN,
    CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    OIDC_ISSUER: 'https://idp.test',
    OIDC_AUDIENCE: 'ggi-api',
    OIDC_JWKS_URI: 'https://idp.test/jwks',
    ...overrides,
  });
}
