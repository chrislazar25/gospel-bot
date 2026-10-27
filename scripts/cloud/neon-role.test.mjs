import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { reconcileRole } from './neon-role.mjs';

const require = createRequire(new URL('../../local-lab/package.json', import.meta.url));
const { Client } = require('pg');
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for the PostgreSQL reconciliation test');
const suffix = randomBytes(8).toString('hex');
const database = `cloud_reconcile_${suffix}`;
const role = `cloud_runtime_${suffix}`;
const statusRole = `cloud_status_${suffix}`;
const password = randomBytes(24).toString('base64url');
const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
const clients = [];
const connect = async (username) => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = '/' + database;
  if (username) { url.username = username; url.password = password; }
  const client = new Client({ connectionString: url.toString() });
  client.on('error', () => {});
  clients.push(client);
  await client.connect();
  return client;
};
try {
  await admin.connect();
  const { rows: [{ current_user: owner }] } = await admin.query('SELECT current_user');
  await admin.query(`CREATE DATABASE ${database}`);
  const client = await connect();
  await client.query('CREATE TABLE schema_migrations (id integer)');
  await client.query('CREATE TABLE deliveries (id integer, status text, attempts integer, provider_id text)');
  await client.query('CREATE TABLE delivery_evidence (id integer)');
  await client.query('CREATE TABLE unrelated (id integer)');
  await client.query('CREATE SEQUENCE unrelated_sequence');
  await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  const observer = await connect(role);
  const options = { role, password, database, owner, readOnly: false };
  let observedDuringRevoke = false;
  const observingClient = {
    async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql.startsWith('REVOKE ALL PRIVILEGES ON ALL TABLES')) {
        await observer.query('SELECT * FROM public.deliveries');
        observedDuringRevoke = true;
      }
      return result;
    },
  };
  await assert.rejects(reconcileRole(observingClient, options), { code: '42703' });
  assert.ok(observedDuringRevoke);
  await observer.query('SELECT * FROM public.deliveries');
  await observer.query('SELECT * FROM public.unrelated');
  console.log('PASS real SQL failure after revoke preserves existing access and concurrent reads');

  const interrupted = await connect();
  const { rows: [{ pid }] } = await interrupted.query('SELECT pg_backend_pid() AS pid');
  await assert.rejects(reconcileRole({
    async query(sql, params) {
      const result = await interrupted.query(sql, params);
      if (sql.startsWith('REVOKE ALL PRIVILEGES ON ALL TABLES')) {
        await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      }
      return result;
    },
  }, options));
  await observer.query('SELECT * FROM public.deliveries');
  await observer.query('SELECT * FROM public.unrelated');
  console.log('PASS terminated reconciliation connection preserves existing role grants');

  await client.query('ALTER TABLE deliveries ADD COLUMN evidence jsonb');
  await reconcileRole(client, options);
  await reconcileRole(client, options);
  await observer.query("INSERT INTO deliveries VALUES (1, 'pending', 0, NULL, NULL)");
  await observer.query("UPDATE deliveries SET status='sent', attempts=1, provider_id='test', evidence='{}' WHERE id=1");
  await observer.query('INSERT INTO delivery_evidence VALUES (1)');
  await observer.query('SELECT * FROM schema_migrations');
  await assert.rejects(observer.query('UPDATE deliveries SET id=2'), { code: '42501' });
  await assert.rejects(observer.query('INSERT INTO schema_migrations VALUES (1)'), { code: '42501' });
  await assert.rejects(observer.query('SELECT * FROM unrelated'), { code: '42501' });
  await assert.rejects(observer.query("SELECT nextval('unrelated_sequence')"), { code: '42501' });
  console.log('PASS committed and repeated runtime reconciliation grants only runtime operations');

  await reconcileRole(client, { ...options, role: statusRole, readOnly: true });
  const status = await connect(statusRole);
  await status.query('SELECT * FROM deliveries');
  assert.equal((await status.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only, 'on');
  const { rows: [privileges] } = await client.query(
    "SELECT has_table_privilege($1, 'deliveries', 'SELECT') AS read, has_table_privilege($1, 'deliveries', 'INSERT') AS write",
    [statusRole],
  );
  assert.deepEqual(privileges, { read: true, write: false });
  await assert.rejects(status.query('INSERT INTO deliveries(id) VALUES (2)'), { code: '25006' });
  console.log('PASS status role creation commits read access and read-only defaults together');
} finally {
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  await admin.query(`DROP ROLE IF EXISTS ${statusRole}`).catch(() => {});
  await admin.end();
}
