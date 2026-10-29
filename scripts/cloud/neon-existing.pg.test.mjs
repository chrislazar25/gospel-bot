import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runNeon } from './neon-operation.mjs';

const require = createRequire(new URL('../../local-lab/package.json', import.meta.url));
const { Client } = require('pg');
if (process.env.TEST_DATABASE_URL !== 'postgres://runtime:runtime@db:5432/runtime') throw new Error('Run through the isolated runtime verification stack');
const databaseName = `neon_existing_${randomBytes(8).toString('hex')}`;
const selection = { organizationId: 'org-test', projectId: 'project-test', branchId: 'br-test', databaseName };
const endpoint = { id: 'ep-test', host: 'ep-test.us-east-2.aws.neon.tech', project_id: selection.projectId,
  branch_id: selection.branchId, type: 'read_write', disabled: false };
const uri = (role, password) => `postgresql://${role}:${password}@${endpoint.host}/${databaseName}?sslmode=require`;
const secrets = new Map([['database', uri('gospel_runtime', 'local-test-only')]]);
let writes = 0;
let generated = 0;
const clients = [];
const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
async function connect(role, password) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  if (role) { url.username = role; url.password = password; }
  const client = new Client({ connectionString: url.href });
  clients.push(client);
  await client.connect();
  return client;
}
const adapters = {
  neon: {
    async metadata(path) {
      if (path.includes('/databases/')) return { database: { branch_id: selection.branchId, name: databaseName, owner_name: 'runtime' } };
      if (path.endsWith('/endpoints')) return { endpoints: [endpoint] };
      if (path.includes('/branches/')) return { branch: { id: selection.branchId, project_id: selection.projectId, name: 'test', protected: false } };
      return { project: { id: selection.projectId, org_id: selection.organizationId, name: 'test', region_id: 'aws-us-east-2' } };
    },
    async connectionUri() { return { uri: uri('runtime', 'runtime') }; },
  },
  async provisioning() {
    return {
      secrets: { async read(key) { return secrets.get(key); }, async write(key, value) { writes++; secrets.set(key, value); } },
      connect: () => connect(), password() { generated++; return randomBytes(32).toString('base64url'); },
    };
  },
};
const run = () => runNeon({ operation: 'provision-existing', selection }, adapters);
try {
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await run();
  assert.equal(generated, 1);
  console.log('PASS existing-project operation accepts a real empty public schema and reuses the saved runtime credential');

  const client = await connect();
  const migration = await readFile(new URL('../../local-lab/migrations/001_initial.sql', import.meta.url), 'utf8');
  await client.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  await client.query(migration);
  await client.query('INSERT INTO schema_migrations(version, checksum) VALUES(1,$1)', [createHash('sha256').update(migration).digest('hex')]);
  const saved = new Map(secrets);
  const savedWrites = writes;
  await run();
  await run();
  assert.equal(writes, savedWrites);
  assert.equal(generated, 1);
  for (const [key, value] of saved) assert.ok(secrets.get(key) === value, 'repetition must preserve every saved credential');
  for (const [key, role] of [['database', 'gospel_runtime'], ['status-database', 'gospel_status']]) {
    const observer = await connect(role, decodeURIComponent(new URL(secrets.get(key)).password));
    assert.ok((await observer.query('SELECT current_user')).rows[0].current_user === role);
    await observer.query('SELECT * FROM public.deliveries');
    if (role === 'gospel_status') assert.ok((await observer.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only === 'on');
  }
  console.log('PASS real app migration catalog passes preflight and repeated runs preserve usable runtime/status passwords');

  await client.query('ALTER TABLE deliveries ADD COLUMN unrelated text');
  await assert.rejects(run(), { message: 'schema_conflict' });
  assert.equal(writes, savedWrites);
  console.log('PASS conflicting real app column is rejected before secret writes');
} catch (error) {
  // SQL messages can embed credentials. Preserve only the assertion/error class in this isolated proof.
  throw new Error(`Existing-project Postgres proof failed (${error instanceof assert.AssertionError ? 'assertion' : 'operation'})`);
} finally {
  await Promise.all(clients.map(client => client.end().catch(() => {})));
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => {});
  await admin.query('DROP ROLE IF EXISTS gospel_status').catch(() => {});
  await admin.end();
}
