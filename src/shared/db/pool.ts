import { Pool } from 'pg';

export function createPool(databaseUrl: string): Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Server-side cap so no single statement can hold a connection indefinitely.
    statement_timeout: 5_000,
    application_name: 'ggi-backend',
  });
}
