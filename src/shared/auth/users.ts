import type { Pool } from 'pg';

/** Local user ID for an external identity, creating the user on first login. */
export async function findOrCreateUser(
  pool: Pool,
  issuer: string,
  subject: string,
): Promise<string> {
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE idp_issuer = $1 AND idp_subject = $2',
    [issuer, subject],
  );
  if (found.rows[0]) {
    return found.rows[0].id;
  }

  // No-op DO UPDATE instead of DO NOTHING so a concurrent first login still gets the id back.
  const created = await pool.query<{ id: string }>(
    `INSERT INTO users (idp_issuer, idp_subject) VALUES ($1, $2)
     ON CONFLICT (idp_issuer, idp_subject) DO UPDATE SET idp_subject = EXCLUDED.idp_subject
     RETURNING id`,
    [issuer, subject],
  );
  const [row] = created.rows;
  if (!row) {
    throw new Error('user upsert returned no row');
  }
  return row.id;
}
