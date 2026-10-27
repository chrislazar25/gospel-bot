import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const migrationPath = new URL('../migrations/001_initial.sql', import.meta.url);
export async function migrate(db: Pool) {
  const sql = await readFile(migrationPath, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(174256291)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const existing = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=1');
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) throw new Error('migration_checksum_changed');
    } else {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function checkSchema(db: Pool) {
  const expected = createHash('sha256').update(await readFile(migrationPath, 'utf8')).digest('hex');
  const result = await db.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=1');
  if (result.rows[0]?.checksum !== expected) throw new Error('schema_version_mismatch');
}
