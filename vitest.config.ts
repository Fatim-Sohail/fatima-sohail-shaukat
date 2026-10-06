import { existsSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// Optional, git-ignored local overrides (e.g. TEST_DATABASE_URL on a non-default port).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  test: {
    environment: 'node',
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/helpers/testDatabase.ts'],
          // Files share one database; run them one at a time for deterministic state.
          fileParallelism: false,
        },
      },
    ],
  },
});
