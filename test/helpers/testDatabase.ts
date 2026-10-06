import { runner } from 'node-pg-migrate';
import { Client } from 'pg';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://ggi:ggi_dev_password@127.0.0.1:5432/ggi_test';

async function migrate(client: Client, direction: 'up' | 'down'): Promise<void> {
  await runner({
    dbClient: client,
    dir: 'migrations',
    migrationsTable: 'pgmigrations',
    direction,
    count: Infinity,
    checkOrder: true,
    log: () => undefined,
  });
}

/**
 * Vitest global setup: rebuilds the test schema from scratch so every run starts
 * from the same state, and proves the migrations apply, revert and re-apply cleanly.
 */
export async function setup(): Promise<void> {
  const databaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing to reset "${databaseName}": test database names must end in _test`);
  }

  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await migrate(client, 'up');
    await migrate(client, 'down');
    await migrate(client, 'up');
  } finally {
    await client.end();
  }
}
