import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseConfig, createNeonApi, runNeon } from './neon-operation.mjs';

const marker = 'PRIVATE_STAGING_CREDENTIAL';
const preparation = { organizationId: 'org-test', projectId: 'project-test', parentBranchId: 'br-production', databaseName: 'neondb', branchName: 'gospel-staging' };
const child = { id: 'br-staging', project_id: preparation.projectId, name: preparation.branchName, parent_id: preparation.parentBranchId, protected: false };
const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/master',
  GITHUB_REPOSITORY: 'example/gospel', GITHUB_WORKFLOW_REF: 'example/gospel/.github/workflows/neon.yml@refs/heads/master',
  GITHUB_JOB: 'prepare-staging', APP_ENV: 'staging', NEON_API_KEY: marker, NEON_ORG_ID: preparation.organizationId,
  NEON_PROJECT_ID: preparation.projectId, NEON_PARENT_BRANCH_ID: preparation.parentBranchId, NEON_DATABASE_NAME: preparation.databaseName };
function harness() {
  const calls = [];
  const state = { branches: [], parentOwner: 'neondb_owner', childOwner: 'neondb_owner', endpoints: 1, pages: undefined, created: false, waits: 0 };
  const fetch = async (value, options) => {
    const url = new URL(value);
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, `Bearer ${marker}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'POST') {
      state.created = true;
      if (state.create) return state.create();
      state.branches.push({ ...child });
      return { ok: true, json() { assert.fail('creation response must be discarded'); } };
    }
    let body;
    if (url.pathname.endsWith('/branches')) {
      body = state.pages ? state.pages(url) : { branches: state.branches, pagination: {} };
    } else if (url.pathname.endsWith('/endpoints')) {
      const branchId = url.pathname.split('/').at(-2);
      const count = branchId === child.id ? state.endpoints : 1;
      body = { endpoints: Array.from({ length: count }, (_, i) => ({ id: `ep-${i}`, project_id: preparation.projectId,
        branch_id: branchId, type: 'read_write', disabled: false, host: `ep-${i}.us-east-2.aws.neon.tech`, password: marker })) };
    } else if (url.pathname.includes('/databases/')) {
      const branchId = url.pathname.split('/').at(-3);
      body = { database: { branch_id: branchId, name: preparation.databaseName, owner_name: branchId === child.id ? state.childOwner : state.parentOwner, password: marker } };
    } else if (url.pathname.includes('/branches/')) {
      const branchId = url.pathname.split('/').at(-1);
      body = { branch: branchId === preparation.parentBranchId ? { id: branchId, project_id: preparation.projectId, name: 'production', protected: true } : { ...child, ...state.childMetadata } };
    } else {
      body = { project: { id: preparation.projectId, org_id: state.org ?? preparation.organizationId, name: 'gospel-bot', region_id: 'aws-us-east-2', connection_uri: marker } };
    }
    if (state.response) body = state.response(url, body);
    return { ok: true, json: async () => body };
  };
  return { state, calls, run: () => runNeon(parseConfig(env, ['prepare-staging']), {
    neon: createNeonApi(marker, fetch), pause: async () => { state.waits++; state.onWait?.(); },
    provisioning() { assert.fail('preparation requested SQL or GCP capabilities'); },
  }), posts: () => calls.filter(call => call.options.method === 'POST') };
}
async function rejectsSafely(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.message, code);
    assert.ok(!error.stack.includes(marker));
    return true;
  });
}

test('preparation requires exact staging master dispatch before any fetch', () => {
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF', 'GITHUB_JOB', 'APP_ENV']) {
    assert.throws(() => parseConfig({ ...env, [key]: 'other' }, ['prepare-staging']), { message: 'workflow_required' });
  }
  const preload = `data:text/javascript;base64,${Buffer.from("globalThis.fetch = () => { process.stderr.write('FETCH_CALLED'); throw new Error('private'); };").toString('base64')}`;
  for (const overrides of [{ GITHUB_ACTIONS: '' }, { APP_ENV: 'production' }, { GITHUB_JOB: 'inspect' }, { GITHUB_REF: 'refs/heads/feature' }]) {
    const result = spawnSync(process.execPath, ['--import', preload, fileURLToPath(new URL('neon.mjs', import.meta.url)), 'prepare-staging'], {
      env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Neon operation failed: workflow_required\n');
  }
});

test('preparation uses its durable parent even after app selection changes', () => {
  const first = parseConfig(env, ['prepare-staging']);
  const second = parseConfig({ ...env, NEON_BRANCH_ID: child.id }, ['prepare-staging']);
  assert.deepEqual(first, second);
  assert.deepEqual(first.preparation, preparation);
  assert.throws(() => parseConfig({ ...env, NEON_PARENT_BRANCH_ID: undefined, NEON_BRANCH_ID: child.id }, ['prepare-staging']), { message: 'invalid_config' });
});

test('first preparation creates once with exact body and reports only verified metadata', async () => {
  const h = harness();
  const report = await h.run();
  assert.equal(h.posts().length, 1);
  const post = h.posts()[0];
  assert.equal(post.url.pathname, '/api/v2/projects/project-test/branches');
  assert.deepEqual(JSON.parse(post.options.body), { branch: { name: 'gospel-staging', parent_id: 'br-production' }, endpoints: [{ type: 'read_write' }] });
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  assert.equal(report.branchId, child.id);
  assert.equal(report.parentBranchId, preparation.parentBranchId);
  assert.equal(report.created, true);
  assert.ok(!JSON.stringify(report).includes(marker));
  assert.ok(!h.calls.some(({ url }) => /connection_uri|roles/.test(url.pathname)));
  assert.deepEqual(Object.keys(report).sort(), ['operation', 'organizationId', 'projectId', 'branchId', 'databaseName', 'projectName', 'region', 'branchName', 'protected', 'owner', 'readWriteEndpoint', 'parentBranchId', 'created'].sort());
  await h.run();
  assert.equal(h.posts().length, 1);
});

test('existing staging branch is reused without mutation', async () => {
  const h = harness(); h.state.branches = [{ ...child }];
  assert.equal((await h.run()).created, false);
  assert.equal(h.posts().length, 0);
});

test('parent identity and database owner failures prevent any create', async t => {
  for (const [label, mutate, code] of [
    ['organization', h => { h.state.org = 'org-other'; }, 'target_mismatch'],
    ['reserved owner', h => { h.state.parentOwner = 'gospel_runtime'; }, 'reserved_owner'],
    ['database', h => { h.state.response = (url, body) => url.pathname.includes('/databases/') ? { database: { ...body.database, name: 'other' } } : body; }, 'target_mismatch'],
    ['endpoint', h => { h.state.response = (url, body) => url.pathname.endsWith('/endpoints') ? { endpoints: [] } : body; }, 'invalid_endpoint'],
  ]) await t.test(label, async () => {
    const h = harness(); mutate(h); await rejectsSafely(h.run(), code); assert.equal(h.posts().length, 0);
  });
});

test('pagination exhausts every page, exact-filters names, and bounds cursors', async t => {
  await t.test('later exact match', async () => {
    const h = harness();
    h.state.pages = url => url.searchParams.has('cursor') ? { branches: [{ ...child }], pagination: {} }
      : { branches: [{ ...child, id: 'br-near', name: 'gospel-staging-near' }], pagination: { next: 'page-two' } };
    await h.run(); assert.equal(h.posts().length, 0);
    const listed = h.calls.filter(({ url }) => url.pathname.endsWith('/branches'));
    assert.equal(listed.length, 2);
    assert.deepEqual(Object.fromEntries(listed[0].url.searchParams), { search: 'gospel-staging', limit: '100' });
    assert.equal(listed[1].url.searchParams.get('cursor'), 'page-two');
  });
  for (const [label, pages, code, count] of [
    ['duplicates', () => ({ branches: [{ ...child }, { ...child, id: 'br-duplicate' }], pagination: {} }), 'branch_conflict', 1],
    ['missing pagination', () => ({ branches: [] }), 'incomplete_pagination', 1],
    ['cursor cycle', () => ({ branches: [], pagination: { next: 'same' } }), 'incomplete_pagination', 2],
    ['page bound', url => ({ branches: [], pagination: { next: String(Number(url.searchParams.get('cursor') ?? 0) + 1) } }), 'incomplete_pagination', 10],
    ['foreign project', () => ({ branches: [{ ...child, project_id: 'foreign' }], pagination: {} }), 'target_mismatch', 1],
  ]) await t.test(label, async () => {
    const h = harness(); h.state.pages = pages;
    await rejectsSafely(h.run(), code); assert.equal(h.posts().length, 0);
    assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith('/branches')).length, count);
  });
});

test('wrong parent, self, child identity, and inherited owner fail without repair', async t => {
  for (const [label, mutate, code] of [
    ['wrong parent', h => { h.state.branches[0].parent_id = 'br-other'; }, 'branch_conflict'],
    ['self', h => { h.state.branches[0].id = preparation.parentBranchId; }, 'branch_conflict'],
    ['changed child name', h => { h.state.childMetadata = { name: 'other' }; }, 'branch_conflict'],
    ['changed child parent', h => { h.state.childMetadata = { parent_id: 'br-other' }; }, 'branch_conflict'],
    ['changed child project', h => { h.state.childMetadata = { project_id: 'other' }; }, 'branch_conflict'],
    ['changed child id', h => { h.state.childMetadata = { id: 'br-other' }; }, 'target_mismatch'],
    ['inherited owner', h => { h.state.childOwner = 'other_owner'; }, 'target_mismatch'],
  ]) await t.test(label, async () => {
    const h = harness(); h.state.branches = [{ ...child }]; mutate(h);
    await rejectsSafely(h.run(), code); assert.equal(h.posts().length, 0);
  });
});

test('ambiguous creation reconciles by GET and never repeats POST', async t => {
  for (const resolved of [true, false]) await t.test(String(resolved), async () => {
    const h = harness();
    h.state.create = () => { if (resolved) h.state.branches.push({ ...child }); throw new Error(marker); };
    if (resolved) assert.equal((await h.run()).branchId, child.id);
    else { await rejectsSafely(h.run(), 'branch_not_ready'); assert.equal(h.state.waits, 4); }
    assert.equal(h.posts().length, 1);
  });
});

test('initializing child metadata gets bounded read retries', async t => {
  await t.test('eventual ready', async () => {
    const h = harness(); h.state.endpoints = 0;
    h.state.onWait = () => { h.state.endpoints = 1; };
    assert.equal((await h.run()).branchId, child.id);
    assert.equal(h.state.waits, 1); assert.equal(h.posts().length, 1);
  });
  await t.test('readiness bound', async () => {
    const h = harness(); h.state.endpoints = 0;
    await rejectsSafely(h.run(), 'branch_not_ready');
    assert.equal(h.state.waits, 4); assert.equal(h.posts().length, 1);
    h.state.endpoints = 1;
    await h.run(); assert.equal(h.posts().length, 1);
  });
});

test('malicious HTTP and API payloads remain credential safe', async () => {
  const h = harness();
  h.state.create = () => { h.state.branches.push({ ...child, connection_uris: [marker], roles: [{ password: marker }] });
    return { ok: true, get json() { throw new Error(marker); } }; };
  assert.ok(!JSON.stringify(await h.run()).includes(marker));
  const invalid = harness();
  invalid.state.pages = () => ({ branches: marker, pagination: { next: marker }, connection_uri: marker });
  await rejectsSafely(invalid.run(), 'incomplete_pagination');
  const api = createNeonApi(marker, async () => ({ ok: false, status: 403, text() { assert.fail('raw HTTP body must not be read'); } }));
  await rejectsSafely(api.listBranches(preparation.projectId), 'neon_http_403');
});

test('workflow grants preparation only contents read and scopes the key to its command', async () => {
  const text = await readFile(new URL('../../.github/workflows/neon.yml', import.meta.url), 'utf8');
  const job = text.split('  prepare-staging:\n')[1].split('  provision-existing:\n')[0];
  for (const guard of ["github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/master'", "inputs.environment == 'staging'", "inputs.operation == 'prepare-staging'"]) assert.ok(job.includes(guard));
  assert.ok(job.includes('environment: staging') && job.includes('contents: read'));
  assert.ok(job.includes('NEON_PARENT_BRANCH_ID: ${{ vars.NEON_PARENT_BRANCH_ID }}'));
  assert.ok(!/id-token|google-github-actions|GCP_PROJECT_ID|gcloud|NEON_BRANCH_ID:/.test(job));
  assert.equal(job.split('NEON_API_KEY:').length, 2);
  assert.ok(job.indexOf('NEON_API_KEY:') > job.indexOf('run: node scripts/cloud/neon.mjs prepare-staging'));
});
