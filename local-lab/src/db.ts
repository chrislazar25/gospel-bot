import { Pool } from 'pg';

export function createPool(connectionString: string, tls = false) {
  const url = new URL(connectionString);
  if (tls) for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const pool = new Pool({ connectionString: url.href, max: 3, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, ...(tls ? { ssl: { rejectUnauthorized: true } } : {}) });
  pool.on('error', () => process.stderr.write(JSON.stringify({ severity: 'ERROR', event: 'idle_database_connection_failed' }) + '\n'));
  return pool;
}
