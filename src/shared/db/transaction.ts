import type { Pool, PoolClient } from 'pg';

/**
 * Runs `work` inside BEGIN/COMMIT on a dedicated client and rolls back on any error.
 * A client whose ROLLBACK fails is destroyed instead of being returned to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      brokenConnection =
        rollbackError instanceof Error ? rollbackError : new Error('ROLLBACK failed');
    }
    throw error;
  } finally {
    client.release(brokenConnection);
  }
}
