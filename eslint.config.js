import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const INFRASTRUCTURE_PACKAGES = ['fastify', '@fastify/*', 'pg', 'pg-*', 'jose', 'zod'];

/**
 * Clean Architecture boundaries: the domain layer must not depend on frameworks,
 * transport, persistence or outer layers. Exported so the rule itself is unit-tested.
 *
 * @type {import('eslint').Linter.Config}
 */
export const domainBoundaries = {
  files: ['src/modules/*/domain/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: INFRASTRUCTURE_PACKAGES,
            message: 'Domain code must not depend on frameworks, transport or persistence.',
          },
          {
            group: [
              '**/application/**',
              '**/controllers/**',
              '**/repositories/**',
              '**/infrastructure/**',
              '**/shared/http/**',
              '**/shared/db/**',
            ],
            message: 'Domain code must not import from outer layers.',
          },
        ],
      },
    ],
  },
};

/**
 * Application (use-case) layer must not depend on the HTTP transport.
 *
 * @type {import('eslint').Linter.Config}
 */
export const applicationBoundaries = {
  files: ['src/modules/*/application/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['fastify', '@fastify/*', '**/controllers/**', '**/shared/http/**'],
            message: 'Use cases must not depend on the HTTP transport layer.',
          },
        ],
      },
    ],
  },
};

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Assertions on known fixtures are clearer with non-null assertions.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  domainBoundaries,
  applicationBoundaries,
  prettier,
);
