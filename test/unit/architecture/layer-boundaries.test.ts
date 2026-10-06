import path from 'node:path';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { applicationBoundaries, domainBoundaries } from '../../../eslint.config.js';

const eslint = new ESLint({
  cwd: process.cwd(),
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    domainBoundaries,
    applicationBoundaries,
  ],
});

async function restrictedImportsIn(file: string, source: string): Promise<number> {
  const [result] = await eslint.lintText(source, { filePath: path.join(process.cwd(), file) });
  return result!.messages.filter((message) => message.ruleId === 'no-restricted-imports').length;
}

describe('layer boundary lint rules', () => {
  const domainFile = 'src/modules/chat/domain/entities/probe.ts';
  const applicationFile = 'src/modules/chat/application/probe.ts';
  const controllerFile = 'src/modules/chat/controllers/probe.ts';

  it.each([
    "import Fastify from 'fastify';",
    "import helmet from '@fastify/helmet';",
    "import { Pool } from 'pg';",
    "import { z } from 'zod';",
    "import { repo } from '../../repositories/chatRepository.js';",
    "import { useCase } from '../../application/askQuestion.js';",
    "import { pool } from '../../../../shared/db/pool.js';",
  ])('forbids domain code from importing outer layers: %s', async (source) => {
    expect(await restrictedImportsIn(domainFile, source)).toBe(1);
  });

  it('allows domain code to import other domain code', async () => {
    expect(
      await restrictedImportsIn(domainFile, "import { quota } from '../services/quota.js';"),
    ).toBe(0);
  });

  it.each([
    "import type { FastifyRequest } from 'fastify';",
    "import { routes } from '../controllers/chatRoutes.js';",
  ])('forbids use cases from importing the HTTP layer: %s', async (source) => {
    expect(await restrictedImportsIn(applicationFile, source)).toBe(1);
  });

  it('allows use cases to depend on the domain', async () => {
    expect(
      await restrictedImportsIn(
        applicationFile,
        "import { quota } from '../domain/services/quota.js';",
      ),
    ).toBe(0);
  });

  it('allows controllers to use the framework', async () => {
    expect(await restrictedImportsIn(controllerFile, "import Fastify from 'fastify';")).toBe(0);
  });
});
