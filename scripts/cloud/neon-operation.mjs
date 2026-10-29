import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reconcileRole } from './neon-role.mjs';

const require = createRequire(new URL('../../local-lab/package.json', import.meta.url));
const { z } = require('zod');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const name = z.string().min(1).max(63).regex(/^[^\x00-\x1f\x7f]+$/);
const label = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/);
const host = z.string().max(253).regex(/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/).refine(value => !value.includes('-pooler.'));
const selectionSchema = z.object({ organizationId: id, projectId: id, branchId: id, databaseName: name });
const preparationSchema = z.object({ organizationId: id, projectId: id, parentBranchId: id, databaseName: name, branchName: z.literal('gospel-staging') });
const managed = [
  { secret: 'database', role: 'gospel_runtime', readOnly: false },
  { secret: 'status-database', role: 'gospel_status', readOnly: true },
];
const appColumns = {
  deliveries: 'id:uuid channel:text target:text date:text payload:text payload_hash:text status:text attempts:int4 provider_id:text evidence:text created_at:timestamptz updated_at:timestamptz',
  delivery_evidence: 'delivery_id:uuid attempt:int4 fact:text recorded_at:timestamptz',
  schema_migrations: 'version:int4 checksum:text applied_at:timestamptz',
};
const codes = new Set(['invalid_config', 'invalid_operation', 'workflow_required', 'invalid_metadata', 'target_mismatch', 'invalid_endpoint', 'reserved_owner', 'invalid_credential', 'neon_request_failed', 'secret_store_failed', 'database_failed', 'database_target_mismatch', 'schema_conflict', 'role_collision', 'operation_failed', 'branch_conflict', 'incomplete_pagination', 'branch_not_ready']);
class OperationError extends Error {}
const fail = code => { throw new OperationError(code); };
export function safeError(error) {
  return error instanceof OperationError && (codes.has(error.message) || /^neon_http_[1-5][0-9]{2}$/.test(error.message))
    ? error : new OperationError('operation_failed');
}
const parse = (schema, value, code) => {
  const result = schema.safeParse(value);
  if (!result.success) fail(code);
  return result.data;
};

export function parseConfig(env, argv = []) {
  const operation = argv[0] ?? 'inspect';
  if (argv.length > 1 || !['inspect', 'prepare-staging', 'provision-existing'].includes(operation)) fail('invalid_operation');
  if (operation !== 'inspect') {
    const context = parse(z.object({
      GITHUB_ACTIONS: z.literal('true'), GITHUB_EVENT_NAME: z.literal('workflow_dispatch'),
      GITHUB_REF: z.literal('refs/heads/master'), GITHUB_JOB: z.literal(operation),
      GITHUB_REPOSITORY: z.string().max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), GITHUB_WORKFLOW_REF: z.string(),
    }), env, 'workflow_required');
    if (context.GITHUB_WORKFLOW_REF !== `${context.GITHUB_REPOSITORY}/.github/workflows/neon.yml@refs/heads/master`) fail('workflow_required');
  }
  if (operation === 'prepare-staging' && env.APP_ENV !== 'staging') fail('workflow_required');
  const apiKey = parse(z.string().min(1).regex(/^[^\r\n]+$/), env.NEON_API_KEY, 'invalid_config');
  if (operation === 'prepare-staging') {
    const preparation = parse(preparationSchema, { organizationId: env.NEON_ORG_ID, projectId: env.NEON_PROJECT_ID,
      parentBranchId: env.NEON_PARENT_BRANCH_ID, databaseName: env.NEON_DATABASE_NAME, branchName: 'gospel-staging' }, 'invalid_config');
    return { operation, preparation, apiKey };
  }
  const selection = parse(selectionSchema, {
    organizationId: env.NEON_ORG_ID, projectId: env.NEON_PROJECT_ID,
    branchId: env.NEON_BRANCH_ID, databaseName: env.NEON_DATABASE_NAME,
  }, 'invalid_config');
  if (operation === 'inspect') return { operation, selection, apiKey };
  const { GCP_PROJECT_ID, APP_ENV } = parse(z.object({
    GCP_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/), APP_ENV: z.enum(['staging', 'production']),
  }), env, 'invalid_config');
  return { operation, selection, apiKey, secrets: { projectId: GCP_PROJECT_ID, prefix: `gospel-${APP_ENV}` } };
}

export function createNeonApi(apiKey, fetchImpl = fetch) {
  const request = async (path, method = 'GET', body) => {
    try {
      const response = await fetchImpl(`https://console.neon.tech/api/v2/${path}`, {
        method, headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) fail(`neon_http_${response.status}`);
        fail('neon_request_failed');
      }
      if (method === 'GET') return await response.json();
    } catch (error) {
      if (error instanceof OperationError) throw error;
      fail('neon_request_failed');
    }
  };
  return {
    metadata(path) {
      if (!/^projects\/[a-zA-Z0-9_-]+(?:\/branches\/[a-zA-Z0-9_-]+(?:\/databases\/[^/?#]+|\/endpoints)?)?$/.test(path)) fail('invalid_metadata');
      return request(path);
    },
    listBranches(projectId, cursor) {
      const params = new URLSearchParams({ search: 'gospel-staging', limit: '100' });
      if (cursor !== undefined) params.set('cursor', cursor);
      return request(`projects/${projectId}/branches?${params}`);
    },
    createBranch(preparation) {
      return request(`projects/${preparation.projectId}/branches`, 'POST', {
        branch: { name: preparation.branchName, parent_id: preparation.parentBranchId }, endpoints: [{ type: 'read_write' }],
      });
    },
    connectionUri(target) {
      const params = new URLSearchParams({ branch_id: target.branchId, endpoint_id: target.readWriteEndpoint.id,
        database_name: target.databaseName, role_name: target.owner, pooled: 'false' });
      return request(`projects/${target.projectId}/connection_uri?${params}`);
    },
  };
}

// Selection = { organizationId, projectId, branchId, databaseName }. The result adds verified metadata only.
export async function inspectTarget(selection, metadata) {
  try {
    const selected = parse(selectionSchema, selection, 'invalid_config');
    const path = `projects/${selected.projectId}`;
    const branchPath = `${path}/branches/${selected.branchId}`;
    const { project } = parse(z.object({ project: z.object({ id, org_id: id, name: label, region_id: id }) }), await metadata(path), 'invalid_metadata');
    const { branch } = parse(z.object({ branch: z.object({ id, project_id: id, name: label, protected: z.boolean() }) }), await metadata(branchPath), 'invalid_metadata');
    const { database } = parse(z.object({ database: z.object({ branch_id: id, name, owner_name: name }) }), await metadata(`${branchPath}/databases/${encodeURIComponent(selected.databaseName)}`), 'invalid_metadata');
    const { endpoints } = parse(z.object({ endpoints: z.array(z.object({ id, project_id: id, branch_id: id,
      type: z.enum(['read_write', 'read_only']), host, disabled: z.boolean() })) }), await metadata(`${branchPath}/endpoints`), 'invalid_metadata');
    if (project.id !== selected.projectId || project.org_id !== selected.organizationId || branch.id !== selected.branchId
      || branch.project_id !== selected.projectId || database.branch_id !== selected.branchId || database.name !== selected.databaseName
      || endpoints.some(endpoint => endpoint.project_id !== selected.projectId || endpoint.branch_id !== selected.branchId)) fail('target_mismatch');
    const writable = endpoints.filter(endpoint => endpoint.type === 'read_write' && !endpoint.disabled);
    if (writable.length !== 1) fail('invalid_endpoint');
    if (managed.some(entry => entry.role === database.owner_name)) fail('reserved_owner');
    return Object.freeze({ ...selected, projectName: project.name, region: project.region_id,
      branchName: branch.name, protected: branch.protected, owner: database.owner_name,
      readWriteEndpoint: Object.freeze({ id: writable[0].id, host: writable[0].host }) });
  } catch (error) { throw safeError(error); }
}

// BranchPreparation fixes ancestry independently of the selected application branch.
export async function prepareStaging(preparation, neon, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const request = parse(preparationSchema, preparation, 'invalid_config');
  const parent = await inspectTarget({ ...request, branchId: request.parentBranchId }, neon.metadata);
  if (parent.branchName === request.branchName) fail('branch_conflict');
  const branchSchema = z.object({ id, project_id: id, name: label, parent_id: id.nullable() });
  const list = async () => {
    const matches = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = parse(z.object({ branches: z.array(branchSchema), pagination: z.object({
        next: z.string().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/).nullish(),
      }) }), await neon.listBranches(request.projectId, cursor), 'incomplete_pagination');
      if (result.branches.some(branch => branch.project_id !== request.projectId)) fail('target_mismatch');
      matches.push(...result.branches.filter(branch => branch.name === request.branchName));
      if (matches.length > 1) fail('branch_conflict');
      if (!result.pagination.next) return matches[0];
      cursor = result.pagination.next;
      if (cursors.has(cursor)) fail('incomplete_pagination');
      cursors.add(cursor);
    }
    fail('incomplete_pagination');
  };
  let child = await list();
  let created = false;
  if (!child) {
    let creationError;
    // A POST outcome can be ambiguous. Its credential-bearing response is never parsed or retried.
    try { await neon.createBranch(request); created = true; } catch (error) { creationError = safeError(error); }
    for (let attempt = 0; attempt < 5; attempt++) {
      child = await list();
      if (child) break;
      if (attempt < 4) await pause(1000);
    }
    if (!child) {
      if (creationError) throw creationError;
      fail('branch_not_ready');
    }
  }
  const verifyBranch = branch => {
    if (branch.id === request.parentBranchId || branch.project_id !== request.projectId
      || branch.name !== request.branchName || branch.parent_id !== request.parentBranchId) fail('branch_conflict');
  };
  verifyBranch(child);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const target = await inspectTarget({ ...request, branchId: child.id }, async path => {
        const result = await neon.metadata(path);
        if (path === `projects/${request.projectId}/branches/${child.id}`) {
          verifyBranch(parse(z.object({ branch: branchSchema }), result, 'invalid_metadata').branch);
        }
        return result;
      });
      if (target.owner !== parent.owner) fail('target_mismatch');
      return { ...target, parentBranchId: request.parentBranchId, created };
    } catch (error) {
      const code = safeError(error).message;
      if (!['invalid_endpoint', 'neon_http_404', 'neon_http_409', 'neon_http_423', 'neon_http_503'].includes(code)) throw error;
      if (attempt === 4) fail('branch_not_ready');
      await pause(1000);
    }
  }
}

export function validateCredential(value, target, role) {
  try {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) fail('invalid_credential');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== target.readWriteEndpoint.host
      || (url.port && url.port !== '5432') || decodeURIComponent(url.pathname.slice(1)) !== target.databaseName
      || decodeURIComponent(url.username) !== role || !decodeURIComponent(url.password) || url.hash) fail('invalid_credential');
    for (const [key, option] of url.searchParams) {
      if (url.searchParams.getAll(key).length !== 1 || !(
        (key === 'sslmode' && ['require', 'verify-full'].includes(option)) || (key === 'channel_binding' && option === 'require')
      )) fail('invalid_credential');
    }
    if (!url.searchParams.has('sslmode')) fail('invalid_credential');
    return { url, password: decodeURIComponent(url.password) };
  } catch { fail('invalid_credential'); }
}

async function preflight(client, target, stored) {
  const { rows: [identity] } = await client.query('SELECT current_database() AS database, current_user AS owner');
  if (identity?.database !== target.databaseName || identity?.owner !== target.owner) fail('database_target_mismatch');
  const { rows: [schema] } = await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='public'");
  if (!schema || ![target.owner, 'pg_database_owner'].includes(schema.owner)) fail('schema_conflict');
  const { rows: tables } = await client.query("SELECT c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname");
  const expected = Object.keys(appColumns);
  if (tables.length) {
    if (tables.length !== expected.length || tables.some((table, index) => table.name !== expected[index] || table.kind !== 'r' || table.owner !== target.owner)) fail('schema_conflict');
    const checksum = createHash('sha256').update(await readFile(new URL('../../local-lab/migrations/001_initial.sql', import.meta.url))).digest('hex');
    const { rows: migrations } = await client.query('SELECT version, checksum FROM public.schema_migrations');
    if (migrations.length !== 1 || migrations[0].version !== 1 || migrations[0].checksum !== checksum) fail('schema_conflict');
    const { rows: columns } = await client.query("SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position");
    if (expected.some(table => columns.filter(column => column.table_name === table).map(column => `${column.column_name}:${column.udt_name}`).join(' ') !== appColumns[table])) fail('schema_conflict');
  }
  const { rows: roles } = await client.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [managed.map(entry => entry.role)]);
  if (managed.some(entry => !stored[entry.secret] && roles.some(role => role.rolname === entry.role))) fail('role_collision');
}

export async function runNeon({ operation = 'inspect', selection, preparation }, { neon, provisioning, pause }) {
  let client;
  try {
    if (!['inspect', 'prepare-staging', 'provision-existing'].includes(operation)) fail('invalid_operation');
    if (operation === 'prepare-staging') return { operation, ...await prepareStaging(preparation, neon, pause) };
    const target = await inspectTarget(selection, neon.metadata);
    if (operation === 'inspect') return { operation, ...target };
    const { secrets, connect, password = () => randomBytes(32).toString('base64url') } = await provisioning();
    const { uri } = parse(z.object({ uri: z.string() }), await neon.connectionUri(target), 'invalid_credential');
    validateCredential(uri, target, target.owner);
    client = await connect(uri);
    // The session lock spans credentials and both role transactions, including retries from another caller.
    await client.query('SELECT pg_advisory_lock(174256292)');
    const stored = {};
    for (const key of ['migration-database', ...managed.map(entry => entry.secret)]) stored[key] = await secrets.read(key);
    if (stored['migration-database'] !== undefined) validateCredential(stored['migration-database'], target, target.owner);
    for (const entry of managed) if (stored[entry.secret] !== undefined) validateCredential(stored[entry.secret], target, entry.role);
    await preflight(client, target, stored);
    for (const entry of managed) {
      if (stored[entry.secret] !== undefined) continue;
      const url = new URL(uri);
      url.username = entry.role;
      url.password = password();
      stored[entry.secret] = url.href;
      validateCredential(url.href, target, entry.role);
      // Save password intent before SQL so a retry uses the same credential.
      await secrets.write(entry.secret, url.href);
    }
    if (stored['migration-database'] !== uri) await secrets.write('migration-database', uri);
    for (const entry of managed) {
      await reconcileRole(client, { role: entry.role, password: validateCredential(stored[entry.secret], target, entry.role).password,
        database: target.databaseName, owner: target.owner, readOnly: entry.readOnly });
    }
    return { operation, ...target, reconciled: true };
  } catch (error) { throw safeError(error); }
  finally { if (client) { try { await client.end(); } catch {} } }
}

export function createSecretStore({ projectId, prefix }, run) {
  const command = (args, input) => {
    try {
      return run('gcloud', [...args, `--project=${projectId}`, '--quiet'], {
        input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
      });
    } catch { fail('secret_store_failed'); }
  };
  return {
    read(key) {
      const name = `${prefix}-${key}`;
      const listed = command(['secrets', 'versions', 'list', name, '--format=json']);
      if (listed.status !== 0) fail('secret_store_failed');
      let versions;
      try { versions = parse(z.array(z.object({ name: z.string() })), JSON.parse(listed.stdout), 'secret_store_failed'); }
      catch { fail('secret_store_failed'); }
      const result = command(['secrets', 'versions', 'access', 'latest', `--secret=${name}`]);
      if (result.status === 0) return result.stdout.trim();
      if (!versions.length && /\bNOT_FOUND\b/.test(result.stderr ?? '')) return undefined;
      fail('secret_store_failed');
    },
    write(key, value) {
      if (command(['secrets', 'versions', 'add', `${prefix}-${key}`, '--data-file=-'], value).status !== 0) fail('secret_store_failed');
    },
  };
}

export async function connectOwner(uri, Client, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const url = new URL(uri);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = new Client({ connectionString: url.href, ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 10000, query_timeout: 30000, statement_timeout: 30000 });
    client.on('error', () => {});
    try { await client.connect(); return client; }
    catch { try { await client.end(); } catch {} }
    if (attempt < 2) await pause(1000);
  }
  fail('database_failed');
}
