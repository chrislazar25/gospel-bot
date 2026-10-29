import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseConfig, createNeonApi, inspectTarget, runNeon, createSecretStore, connectOwner, validateCredential } from './neon-operation.mjs';

const selection = { organizationId: 'org-test', projectId: 'patient-field-test', branchId: 'br-test', databaseName: 'neondb' };
const endpoint = { id: 'ep-test', host: 'ep-test.us-east-2.aws.neon.tech', project_id: selection.projectId, branch_id: selection.branchId, type: 'read_write', disabled: false };
const owner = 'neondb_owner';
const marker = 'PRIVATE_SENTINEL_DO_NOT_PRINT';
const credential = (role = owner, password = marker) => `postgresql://${role}:${password}@${endpoint.host}/neondb?sslmode=require&channel_binding=require`;
const checksum = createHash('sha256').update(await readFile(new URL('../../local-lab/migrations/001_initial.sql', import.meta.url))).digest('hex');
const metadataFixtures = () => ({
  project: { project: { id: selection.projectId, org_id: selection.organizationId, name: 'Existing project', region_id: 'aws-us-east-2' } },
  branch: { branch: { id: selection.branchId, project_id: selection.projectId, name: 'Existing branch', protected: false } },
  database: { database: { branch_id: selection.branchId, name: selection.databaseName, owner_name: owner } },
  endpoints: { endpoints: [{ ...endpoint }] },
});
function harness(shared = {}) {
  const fixtures = metadataFixtures();
  const trace = [];
  const secrets = shared.secrets ?? new Map();
  const roles = shared.roles ?? new Set();
  const writes = [];
  const passwords = shared.passwords ?? new Map();
  const tables = [];
  let crash;
  let identity = { database: selection.databaseName, owner };
  let migrations = [{ version: 1, checksum }];
  let schemaOwner = 'pg_database_owner';
  const columns = Object.entries({
    deliveries: 'id:uuid channel:text target:text date:text payload:text payload_hash:text status:text attempts:int4 provider_id:text evidence:text created_at:timestamptz updated_at:timestamptz',
    delivery_evidence: 'delivery_id:uuid attempt:int4 fact:text recorded_at:timestamptz',
    schema_migrations: 'version:int4 checksum:text applied_at:timestamptz',
  }).flatMap(([table_name, fields]) => fields.split(' ').map(field => {
    const [column_name, udt_name] = field.split(':'); return { table_name, column_name, udt_name };
  }));
  let closed = 0;
  let locked = false;
  let generated = 0;
  const client = {
    async query(sql, args) {
      trace.push(['sql', sql.split(' ')[0]]);
      if (crash === 'sql') throw new Error(marker);
      if (sql.startsWith('SELECT pg_advisory_lock')) {
        if (shared.acquire) await shared.acquire();
        locked = true;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT current_database')) return { rows: [identity] };
      if (sql.startsWith('SELECT pg_get_userbyid')) return { rows: [{ owner: schemaOwner }] };
      if (sql.startsWith('SELECT c.relname')) return { rows: tables };
      if (sql.startsWith('SELECT table_name')) return { rows: columns };
      if (sql.startsWith('SELECT version')) return { rows: migrations };
      if (sql.startsWith('SELECT rolname')) return { rows: [...roles].map(rolname => ({ rolname })) };
      if (sql === 'SELECT 1 FROM pg_roles WHERE rolname=$1') return { rowCount: Number(roles.has(args[0])) };
      if (sql.startsWith('SELECT column_name')) return { rowCount: 0, rows: [] };
      if (/^(CREATE|ALTER) ROLE/.test(sql) && sql.includes('PASSWORD')) {
        const [, role, password] = sql.match(/ROLE "([^"]+)" (?:LOGIN )?PASSWORD '([^']+)'/);
        assert.ok(role !== owner, 'owner role must never be changed');
        roles.add(role);
        passwords.set(role, password);
        if (crash === 'role') { crash = undefined; throw new Error(marker); }
      }
      return { rows: [], rowCount: 0 };
    },
    async end() { closed++; if (locked) { locked = false; shared.release?.(); } },
  };
  const adapters = {
    neon: {
      async metadata(path) {
        trace.push(['metadata', path]);
        if (path.includes('/databases/')) return fixtures.database;
        if (path.endsWith('/endpoints')) return fixtures.endpoints;
        if (path.includes('/branches/')) return fixtures.branch;
        return fixtures.project;
      },
      async connectionUri(target) { trace.push(['uri', target.branchId, target.owner]); return { uri: credential() }; },
    },
    async provisioning() {
      trace.push(['provisioning']);
      return {
        secrets: {
          async read(key) { trace.push(['read', key]); if (crash === `read:${key}`) throw new Error(marker); return secrets.get(key); },
          async write(key, value) {
            trace.push(['write', key]); writes.push(key);
            if (crash === `before:${key}`) { crash = undefined; throw new Error(marker); }
            secrets.set(key, value);
            if (crash === `after:${key}`) { crash = undefined; throw new Error(marker); }
          },
        },
        async connect() { trace.push(['connect']); if (crash === 'connect') throw new Error(marker); return client; },
        password() { generated++; return `generated-password-${generated}`; },
      };
    },
  };
  return { fixtures, trace, secrets, roles, writes, passwords, tables, columns, adapters, client,
    set crash(value) { crash = value; }, set identity(value) { identity = value; },
    set migrations(value) { migrations = value; }, set schemaOwner(value) { schemaOwner = value; },
    get closed() { return closed; }, get generated() { return generated; },
    run(operation = 'provision-existing') { return runNeon({ operation, selection }, adapters); },
  };
}
async function rejectsSafely(promise, code) {
  try { await promise; assert.fail('expected operation failure'); }
  catch (error) {
    assert.ok(!String(error.stack).includes(marker), 'failure must not contain credentials');
    assert.ok(error.message === code, `expected safe error ${code}`);
  }
}

const configEnv = { NEON_ORG_ID: selection.organizationId, NEON_PROJECT_ID: selection.projectId,
  NEON_BRANCH_ID: selection.branchId, NEON_DATABASE_NAME: selection.databaseName, NEON_API_KEY: marker };

test('default inspection only reads selected metadata and reports allowlisted fields', async () => {
  const h = harness();
  h.fixtures.project.project.credentials = marker;
  const config = parseConfig(configEnv);
  assert.equal(config.operation, 'inspect');
  const report = await runNeon(config, { neon: { metadata: h.adapters.neon.metadata }, provisioning() { assert.fail('inspection requested credential capabilities'); } });
  assert.equal(h.trace.length, 4);
  assert.ok(h.trace.every(([kind]) => kind === 'metadata'));
  assert.ok(h.trace[2][1].endsWith('/branches/br-test/databases/neondb'));
  assert.ok(report.owner === owner && report.readWriteEndpoint.id === endpoint.id);
  assert.ok(!JSON.stringify(report).includes(marker));
});

test('metadata mismatches and malformed owners/endpoints fail before provisioning', async t => {
  const cases = [
    ['organization', h => { h.fixtures.project.project.org_id = 'org-other'; }, 'target_mismatch'],
    ['project', h => { h.fixtures.project.project.id = 'other'; }, 'target_mismatch'],
    ['branch', h => { h.fixtures.branch.branch.id = 'br-other'; }, 'target_mismatch'],
    ['branch project', h => { h.fixtures.branch.branch.project_id = 'other'; }, 'target_mismatch'],
    ['database branch', h => { h.fixtures.database.database.branch_id = 'br-other'; }, 'target_mismatch'],
    ['database name', h => { h.fixtures.database.database.name = 'other'; }, 'target_mismatch'],
    ['missing owner', h => { delete h.fixtures.database.database.owner_name; }, 'invalid_metadata'],
    ['reserved runtime owner', h => { h.fixtures.database.database.owner_name = 'gospel_runtime'; }, 'reserved_owner'],
    ['reserved status owner', h => { h.fixtures.database.database.owner_name = 'gospel_status'; }, 'reserved_owner'],
    ['endpoint project', h => { h.fixtures.endpoints.endpoints[0].project_id = 'other'; }, 'target_mismatch'],
    ['endpoint branch', h => { h.fixtures.endpoints.endpoints[0].branch_id = 'other'; }, 'target_mismatch'],
    ['endpoint hostname', h => { h.fixtures.endpoints.endpoints[0].host = 'elsewhere.invalid'; }, 'invalid_metadata'],
    ['pooled endpoint', h => { h.fixtures.endpoints.endpoints[0].host = 'ep-test-pooler.us-east-2.aws.neon.tech'; }, 'invalid_metadata'],
    ['disabled endpoint', h => { h.fixtures.endpoints.endpoints[0].disabled = true; }, 'invalid_endpoint'],
    ['read only endpoint', h => { h.fixtures.endpoints.endpoints[0].type = 'read_only'; }, 'invalid_endpoint'],
    ['no endpoints', h => { h.fixtures.endpoints.endpoints = []; }, 'invalid_endpoint'],
    ['two endpoints', h => { h.fixtures.endpoints.endpoints.push({ ...endpoint, id: 'ep-second' }); }, 'invalid_endpoint'],
  ];
  for (const [label, change, code] of cases) await t.test(label, async () => {
    const h = harness(); change(h);
    await rejectsSafely(h.run(), code);
    assert.ok(h.trace.every(([kind]) => kind === 'metadata'));
  });
});

test('Neon adapter is GET-only, pins all connection URI parameters, and restricts metadata capability', async () => {
  const calls = [];
  const api = createNeonApi(marker, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ uri: credential() }) }; });
  const target = { ...selection, owner, readWriteEndpoint: endpoint };
  await api.connectionUri(target);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://console.neon.tech');
  assert.equal(url.pathname, `/api/v2/projects/${selection.projectId}/connection_uri`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { branch_id: selection.branchId, endpoint_id: endpoint.id, database_name: 'neondb', role_name: owner, pooled: 'false' });
  assert.ok(calls[0].options.method === 'GET' && calls[0].options.redirect === 'error' && calls[0].options.signal instanceof AbortSignal);
  assert.throws(() => api.metadata(`projects/${selection.projectId}/connection_uri`), { message: 'invalid_metadata' });
  assert.equal(calls.length, 1);
});

test('Neon HTTP, transport, and response errors never expose bodies or credentials', async () => {
  for (const [response, code] of [
    [{ ok: false, status: 403, text: () => { throw new Error(marker); } }, 'neon_http_403'],
    [{ ok: true, json: async () => { throw new Error(marker); } }, 'neon_request_failed'],
    [null, 'neon_request_failed'],
  ]) {
    const api = createNeonApi(marker, async () => { if (!response) throw new Error(marker); return response; });
    await rejectsSafely(api.metadata(`projects/${selection.projectId}`), code);
  }
  await rejectsSafely(inspectTarget(selection, async () => ({ project: marker })), 'invalid_metadata');
});

test('every malformed or foreign stored URL, including migration URL, causes zero writes and no catalog preflight', async t => {
  const changes = [
    ['malformed', () => marker],
    ['host', url => { url.hostname = 'ep-other.us-east-2.aws.neon.tech'; }],
    ['pooled host', url => { url.hostname = 'ep-test-pooler.us-east-2.aws.neon.tech'; }],
    ['database', url => { url.pathname = '/other'; }],
    ['username', url => { url.username = 'other'; }],
    ['port', url => { url.port = '6543'; }],
    ['protocol', url => url.href.replace('postgresql:', 'https:')],
    ['empty password', url => { url.password = ''; }],
    ['no sslmode', url => { url.searchParams.delete('sslmode'); }],
    ['weak TLS', url => { url.searchParams.set('sslmode', 'disable'); }],
    ['duplicate TLS', url => { url.searchParams.append('sslmode', 'require'); }],
    ['TLS root override', url => { url.searchParams.set('sslrootcert', '/tmp/ca'); }],
    ['options', url => { url.searchParams.set('options', '-csearch_path=other'); }],
    ['fallback host', url => { url.searchParams.set('host', 'other'); }],
    ['channel binding', url => { url.searchParams.set('channel_binding', 'disable'); }],
    ['fragment', url => { url.hash = 'private'; }],
    ['invalid escape', url => { url.password = '%xx'; }],
  ];
  for (const [key, role] of [['migration-database', owner], ['database', 'gospel_runtime'], ['status-database', 'gospel_status']]) {
    for (const [label, change] of changes) await t.test(`${key} ${label}`, async () => {
      const h = harness();
      const url = new URL(credential(role));
      const replacement = change(url);
      h.secrets.set(key, replacement ?? url.href);
      await rejectsSafely(h.run(), 'invalid_credential');
      assert.equal(h.writes.length, 0);
      assert.ok(h.trace.filter(([kind]) => kind === 'sql').every(([, verb]) => verb === 'SELECT'));
      assert.equal(h.closed, 1);
      assert.equal(h.trace.filter(([kind]) => kind === 'read').length, 3);
    });
  }
});

test('owner URL is validated before secret or SQL access', async () => {
  const h = harness();
  h.adapters.neon.connectionUri = async () => ({ uri: credential().replace(endpoint.host, 'other.invalid') });
  await rejectsSafely(h.run(), 'invalid_credential');
  assert.ok(!h.trace.some(([kind]) => ['read', 'connect', 'write'].includes(kind)));
});

test('SQL identity, schema ownership, unrelated tables, bad migrations, and role collisions cause zero writes', async t => {
  const appTables = ['deliveries', 'delivery_evidence', 'schema_migrations'].map(name => ({ name, owner, kind: 'r' }));
  const cases = [
    ['database', h => { h.identity = { database: 'other', owner }; }, 'database_target_mismatch'],
    ['owner', h => { h.identity = { database: 'neondb', owner: 'other' }; }, 'database_target_mismatch'],
    ['schema owner', h => { h.schemaOwner = 'other'; }, 'schema_conflict'],
    ['unrelated table', h => { h.tables.push({ name: 'unrelated', owner, kind: 'r' }); }, 'schema_conflict'],
    ['table owner', h => { h.tables.push(...appTables.map(table => ({ ...table, owner: 'other' }))); }, 'schema_conflict'],
    ['view collision', h => { h.tables.push(...appTables.map(table => ({ ...table, kind: 'v' }))); }, 'schema_conflict'],
    ['migration checksum', h => { h.tables.push(...appTables); h.migrations = [{ version: 1, checksum: 'wrong' }]; }, 'schema_conflict'],
    ['migration version', h => { h.tables.push(...appTables); h.migrations = [{ version: 2, checksum }]; }, 'schema_conflict'],
    ['missing migration', h => { h.tables.push(...appTables); h.migrations = []; }, 'schema_conflict'],
    ['conflicting column', h => { h.tables.push(...appTables); h.columns[0].udt_name = 'text'; }, 'schema_conflict'],
    ['extra column', h => { h.tables.push(...appTables); h.columns.push({ table_name: 'deliveries', column_name: 'unrelated', udt_name: 'text' }); }, 'schema_conflict'],
    ['runtime collision', h => { h.roles.add('gospel_runtime'); }, 'role_collision'],
    ['status collision', h => { h.roles.add('gospel_status'); }, 'role_collision'],
  ];
  for (const [label, change, code] of cases) await t.test(label, async () => {
    const h = harness(); change(h);
    await rejectsSafely(h.run(), code);
    assert.equal(h.writes.length, 0);
    assert.equal(h.closed, 1);
    assert.equal(h.passwords.size, 0);
  });
  const h = harness(); h.tables.push(...appTables);
  await h.run();
  assert.equal(h.passwords.size, 2);
});

test('missing secret container aborts before catalog preflight or writes', async () => {
  const h = harness(); h.crash = 'read:status-database';
  await rejectsSafely(h.run(), 'operation_failed');
  assert.equal(h.writes.length, 0);
  assert.equal(h.closed, 1);
  assert.equal(h.passwords.size, 0);
});

test('Secret Manager distinguishes missing containers, denied access, and empty containers', async () => {
  let trace = [];
  let scenario;
  const run = (binary, args, options) => {
    trace.push([binary, ...args]);
    assert.ok(options.timeout === 30000 && options.encoding === 'utf8');
    if (args.includes('list')) {
      if (scenario === 'missing') return { status: 1, stderr: marker + ' NOT_FOUND' };
      return { status: 0, stdout: scenario === 'populated' ? '[{"name":"versions/1"}]' : '[]' };
    }
    if (args.includes('access')) return { status: 1, stderr: scenario === 'denied' ? marker + ' PERMISSION_DENIED' : marker + ' NOT_FOUND' };
    assert.fail('preflight must not write');
  };
  const store = createSecretStore({ projectId: 'test-project', prefix: 'gospel-staging' }, run);
  for (scenario of ['missing', 'denied', 'populated']) {
    trace = [];
    assert.throws(() => store.read('database'), { message: 'secret_store_failed' });
    assert.ok(!trace.some(args => args.includes('add')));
    assert.equal(trace.length, scenario === 'missing' ? 1 : 2);
  }
  scenario = 'empty';
  assert.equal(store.read('database'), undefined);
});

test('stored passwords survive repetitions and crashes before/after every secret write and during SQL', async t => {
  for (const crash of [undefined, ...['database', 'status-database', 'migration-database'].flatMap(key => [`before:${key}`, `after:${key}`]), 'role']) {
    await t.test(crash ?? 'repeat', async () => {
      const h = harness();
      if (crash) { h.crash = crash; await rejectsSafely(h.run(), 'operation_failed'); }
      const saved = new Map(h.secrets);
      await h.run();
      for (const [key, value] of saved) assert.ok(h.secrets.get(key) === value, 'retry must preserve a persisted credential');
      const complete = new Map(h.secrets);
      const writeCount = h.writes.length;
      const generated = h.generated;
      await h.run();
      assert.equal(h.writes.length, writeCount);
      assert.equal(h.generated, generated);
      for (const [key, value] of complete) assert.ok(h.secrets.get(key) === value, 'repeat must preserve credentials');
      for (const [key, role] of [['database', 'gospel_runtime'], ['status-database', 'gospel_status']]) {
        assert.ok(h.passwords.get(role) === decodeURIComponent(new URL(h.secrets.get(key)).password), 'SQL and persisted role password must agree');
      }
      assert.ok(h.secrets.get('migration-database') === credential());
      const firstWrite = h.trace.findIndex(([kind]) => kind === 'write');
      const firstSql = h.trace.findIndex(([kind]) => kind === 'sql');
      assert.ok(firstWrite > firstSql, 'all SQL preflight must precede writes');
      assert.equal(h.passwords.size, 2);
    });
  }
});

test('existing managed passwords are reused, and malformed migration credentials still block writes', async () => {
  const h = harness();
  h.secrets.set('database', credential('gospel_runtime', 'saved-runtime'));
  h.secrets.set('status-database', credential('gospel_status', 'saved-status'));
  h.roles.add('gospel_runtime'); h.roles.add('gospel_status');
  await h.run();
  assert.equal(h.generated, 0);
  assert.ok(h.passwords.get('gospel_runtime') === 'saved-runtime');
  assert.ok(h.passwords.get('gospel_status') === 'saved-status');
  assert.deepEqual(h.writes, ['migration-database']);
});

test('SQL and adapter errors are redacted and connected clients are always closed', async () => {
  for (const crash of ['sql', 'connect']) {
    const h = harness(); h.crash = crash;
    await rejectsSafely(h.run(), 'operation_failed');
    assert.equal(h.closed, crash === 'sql' ? 1 : 0);
    assert.equal(h.writes.length, 0);
  }
});

test('owner connector enforces verified TLS and bounds retries while closing failed clients', async () => {
  const seen = [];
  let ends = 0;
  let pauses = 0;
  class Client {
    constructor(options) { seen.push(options); }
    on() {}
    async connect() { throw new Error(marker); }
    async end() { ends++; }
  }
  await rejectsSafely(connectOwner(credential(), Client, async () => { pauses++; }), 'database_failed');
  assert.equal(seen.length, 3); assert.equal(ends, 3); assert.equal(pauses, 2);
  for (const options of seen) {
    assert.ok(options.ssl.rejectUnauthorized && options.connectionTimeoutMillis === 10000 && options.query_timeout === 30000);
    assert.ok(!new URL(options.connectionString).searchParams.has('sslmode'));
  }
});

test('supported TLS forms and encoded PostgreSQL passwords are accepted', () => {
  const target = { ...selection, readWriteEndpoint: endpoint };
  for (const mode of ['require', 'verify-full']) {
    const value = new URL(credential('gospel_runtime')); value.password = encodeURIComponent('encoded @:/% password');
    value.port = '5432'; value.searchParams.set('sslmode', mode);
    assert.ok(validateCredential(value.href, target, 'gospel_runtime').password === 'encoded @:/% password');
  }
});

test('CLI rejects invalid modes/config without credential output and imports without execution', () => {
  const path = fileURLToPath(new URL('neon.mjs', import.meta.url));
  const env = { PATH: process.env.PATH, NEON_API_KEY: marker, GCP_PROJECT_ID: marker };
  for (const args of [['bad-mode'], [], ['inspect', 'extra'], ['provision-existing']]) {
    const result = spawnSync(process.execPath, [path, ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.ok(result.stdout === '' && !result.stderr.includes(marker));
    assert.ok(/^Neon operation failed: (invalid_operation|invalid_config|workflow_required)\n$/.test(result.stderr));
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('neon.mjs', import.meta.url).href)})`], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  assert.ok(result.stdout === '' && result.stderr === '');
});

test('real CLI defaults to metadata inspection with no GCP config or provision capabilities', () => {
  const fixtures = metadataFixtures();
  const bootstrap = `
    const fixtures = ${JSON.stringify(fixtures)};
    let calls = 0;
    globalThis.fetch = async (value, options) => {
      const url = new URL(value);
      if (options.method !== 'GET' || url.pathname.includes('connection_uri')) throw new Error('private failure');
      calls++;
      const body = url.pathname.includes('/databases/') ? fixtures.database : url.pathname.endsWith('/endpoints') ? fixtures.endpoints : url.pathname.includes('/branches/') ? fixtures.branch : fixtures.project;
      return { ok: true, json: async () => body };
    };
    process.on('exit', () => { if (calls !== 4) process.exitCode = 3; });
  `;
  const preload = `data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`;
  for (const args of [[], ['inspect']]) {
    const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('neon.mjs', import.meta.url)), ...args], {
      env: configEnv, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0);
    assert.ok(result.stderr === '' && !result.stdout.includes(marker));
    const report = JSON.parse(result.stdout);
    assert.ok(report.operation === 'inspect' && report.branchId === selection.branchId && report.owner === owner);
  }
});

test('Neon workflow keeps inspection free of GCP authentication and pins both commands', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/neon.yml', import.meta.url), 'utf8');
  const inspect = workflow.split('  inspect:\n')[1].split('  provision-existing:\n')[0];
  const provision = workflow.split('  provision-existing:\n')[1];
  assert.ok(workflow.includes('default: inspect') && workflow.includes('group: cloud-${{ inputs.environment }}'));
  for (const job of [inspect, provision]) {
    assert.ok(job.includes("github.ref == 'refs/heads/master'"));
    for (const key of ['NEON_ORG_ID', 'NEON_PROJECT_ID', 'NEON_BRANCH_ID', 'NEON_DATABASE_NAME', 'NEON_API_KEY']) assert.ok(job.includes(`${key}:`));
  }
  assert.ok(inspect.includes('run: node scripts/cloud/neon.mjs inspect'));
  assert.ok(!/id-token|google-github-actions|GCP_PROJECT_ID|APP_ENV|gcloud/.test(inspect));
  assert.ok(provision.includes('run: node scripts/cloud/neon.mjs provision-existing') && provision.includes('id-token: write'));
});

test('overlapping provisioners serialize secrets and preserve password intent after a crash', async t => {
  for (const crash of [undefined, 'after:database', 'after:status-database', 'after:migration-database', 'role']) {
    await t.test(crash ?? 'successful overlap', async () => {
      let held = false;
      let acquired = 0;
      const waiters = [];
      const shared = {
        secrets: new Map(), roles: new Set(), passwords: new Map(),
        async acquire() {
          if (held) await new Promise(resolve => waiters.push(resolve));
          held = true; acquired++;
        },
        release() { const next = waiters.shift(); if (next) next(); else held = false; },
      };
      const first = harness(shared);
      const second = harness(shared);
      first.crash = crash;
      const results = await Promise.allSettled([first.run(), second.run()]);
      assert.ok(results[0].status === (crash ? 'rejected' : 'fulfilled'));
      assert.ok(results[1].status === 'fulfilled');
      assert.equal(acquired, 2);
      assert.equal(first.generated + second.generated, 2);
      assert.equal(held, false);
      for (const [key, role] of [['database', 'gospel_runtime'], ['status-database', 'gospel_status']]) {
        assert.ok(shared.passwords.get(role) === decodeURIComponent(new URL(shared.secrets.get(key)).password), 'both provisioners must use the persisted password');
      }
      assert.equal(first.closed, 1); assert.equal(second.closed, 1);
      const writes = [...first.writes, ...second.writes];
      assert.equal(writes.filter(key => key === 'database').length, 1);
      assert.equal(writes.filter(key => key === 'status-database').length, 1);
    });
  }
});

test('provisioning config requires the exact master dispatch job before credentials are parsed', () => {
  const context = {
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master',
    GITHUB_REPOSITORY: 'example/gospel', GITHUB_WORKFLOW_REF: 'example/gospel/.github/workflows/neon.yml@refs/heads/master',
    GITHUB_JOB: 'provision-existing',
  };
  const env = { ...configEnv, ...context, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project' };
  assert.equal(parseConfig(env, ['provision-existing']).operation, 'provision-existing');
  for (const key of Object.keys(context)) {
    assert.throws(() => parseConfig({ ...env, [key]: 'other' }, ['provision-existing']), { message: 'workflow_required' });
  }
  assert.throws(() => parseConfig({ ...env, GITHUB_REPOSITORY: 'bad repository' }, ['provision-existing']), { message: 'workflow_required' });
  const preload = `data:text/javascript;base64,${Buffer.from("globalThis.fetch = () => { process.stderr.write('FETCH_CALLED'); throw new Error('private'); };").toString('base64')}`;
  const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('neon.mjs', import.meta.url)), 'provision-existing'], {
    env: { ...configEnv, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.ok(result.stdout === '' && result.stderr === 'Neon operation failed: workflow_required\n');
});
