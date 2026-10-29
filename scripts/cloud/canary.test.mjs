import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'gospel-canary-tests-'));
const digest = 'sha256:' + 'b'.repeat(64);
const image = `us-central1-docker.pkg.dev/test-project/gospel/canary@${digest}`;
const execution = 'gospel-staging-canary-abc12';
const script = fileURLToPath(new URL('canary.sh', import.meta.url));
const terraform = readFileSync(new URL('../../infra/canary/main.tf', import.meta.url), 'utf8');
const resources = [...terraform.matchAll(/resource "([^"]+)"/g)].map(match => match[1]);
assert.ok(resources.every(type => ['google_service_account', 'google_service_account_iam_member', 'google_secret_manager_secret_iam_member', 'google_cloud_run_v2_job', 'google_cloud_run_v2_job_iam_member'].includes(type)));
assert.ok(!/data "terraform_remote_state"|roles\/logging\.|google_project_iam_member/.test(terraform));

const stub = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const name=path.basename(process.argv[1]);const args=process.argv.slice(2);const scenario=process.env.SCENARIO;
fs.appendFileSync(process.env.TRACE,JSON.stringify({name,args})+'\\n');
if(name==='docker'){
 if(args[0]==='push')fs.writeFileSync(process.env.PUSHED,'yes');
 if(args[0]==='image')console.log(JSON.stringify({'org.opencontainers.image.revision':scenario==='wrong-revision'?'c'.repeat(40):process.env.GITHUB_SHA,'io.gospel.image-purpose':scenario==='wrong-purpose'?'runtime':'canary'}));
}
if(name==='gcloud'){
 if(scenario==='raw-error'){console.error('15555550123@c.us secret-token raw-provider-error');process.exit(1)}
 if(args[0]==='artifacts'){
  if(scenario.startsWith('new-image')&&!fs.existsSync(process.env.PUSHED)){console.error(scenario==='new-image-cli'?'Image not found.':'NOT_FOUND');process.exit(1)}
  console.log('${digest}');
 }
 if(args[0]==='run'&&args[2]==='execute'){
  if(scenario==='launch-fails')process.exit(1);
  console.log('${execution}');
 }
 if(args[0]==='run'&&args[2]==='executions'){
  const count=fs.readFileSync(process.env.TRACE,'utf8').trim().split('\\n').map(JSON.parse).filter(row=>row.args[2]==='executions').length;
  const pending=scenario==='pending-forever'||(scenario==='initially-pending'&&count===1);
  console.log(JSON.stringify({metadata:{name:'${execution}',labels:{'run.googleapis.com/job':scenario==='wrong-job'?'gospel-staging-send':'gospel-staging-canary'}},
   spec:{taskCount:1,template:{spec:{containers:[{image:scenario==='wrong-image'?'runtime:latest':'${image}',command:['node'],args:scenario==='wrong-command'?['dist/runtime.js','send']:['dist/canary.js'],env:[{name:'TARGET_CHAT_ID',value:'15555550123@c.us'},{name:'SECRET',value:'secret-token'}]}]}}},
   status:{succeededCount:scenario==='failed-execution'?0:1,failedCount:scenario==='failed-execution'?1:0,conditions:[{type:'Completed',status:pending?'Unknown':scenario==='failed-execution'?'False':'True',message:'raw-provider-error'}]}}));
 }
}
`;
try {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  for (const name of ['docker', 'gcloud', 'sleep']) writeFileSync(join(directory, name), stub, { mode: 0o755 });
  writeFileSync(join(directory, '.gitignore'), 'canary-evidence/\ntrace.jsonl\npushed\n');
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Canary test', '-c', 'user.email=canary@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const sha = git('rev-parse', 'HEAD');
  function exercise(args, scenario, expected, overrides = {}) {
    const trace = join(directory, 'trace.jsonl'); writeFileSync(trace, ''); rmSync(join(directory, 'pushed'), { force: true });
    const result = spawnSync('/bin/bash', [script, ...args], { cwd: directory, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project', REGION: 'us-central1',
        GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'canary', GITHUB_REPOSITORY: 'example/gospel', GITHUB_WORKFLOW_REF: 'example/gospel/.github/workflows/release.yml@refs/heads/master', GITHUB_REF: 'refs/heads/master', GITHUB_SHA: sha, CANARY_IMAGE: image, CANARY_REVISION: sha, BUILD_ONLY: 'false', SMOKE_ONLY: 'false', STAGING_RUN: '',
        SCENARIO: scenario, TRACE: trace, PUSHED: join(directory, 'pushed'), ...overrides },
    });
    assert.equal(result.status, expected, JSON.stringify({ args, scenario, stdout: result.stdout, stderr: result.stderr }));
    const logs = result.stdout + result.stderr;
    assert.ok(!/15555550123|secret-token|raw-provider-error/.test(logs), logs);
    if (existsSync(join(directory, 'canary-evidence'))) for (const file of readdirSync(join(directory, 'canary-evidence'))) {
      assert.ok(!/15555550123|secret-token|raw-provider-error/.test(readFileSync(join(directory, 'canary-evidence', file), 'utf8')), file);
    }
    return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  }
  for (const args of [['validate', 'publish'], ['publish'], ['execute']]) {
    for (const invalid of [{ APP_ENV: 'production' }, { BUILD_ONLY: 'true' }, { SMOKE_ONLY: 'true' }, { STAGING_RUN: '123' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_ACTIONS: '' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_JOB: 'release' }, { GITHUB_WORKFLOW_REF: 'example/gospel/.github/workflows/ci.yml@refs/heads/master' }, { GITHUB_REPOSITORY: 'other/repo' }]) assert.equal(exercise(args, 'guard', 1, invalid).length, 0);
  }
  assert.equal(exercise(['execute', 'extra'], 'guard', 1).length, 0);
  assert.equal(exercise(['validate', 'execute'], 'guard', 1, { CANARY_REVISION: 'c'.repeat(40) }).length, 0);
  for (const CANARY_IMAGE of [image.replace('/canary@', '/runtime@'), image.replace('test-project', 'other-project'), image.replace('@' + digest, ':latest')]) assert.equal(exercise(['execute'], 'guard', 1, { CANARY_IMAGE }).length, 0);
  console.log('PASS option conflicts, production, unreviewed revisions and wrong image scopes fail before cloud access');
  assert.equal(exercise(['validate', 'execute'], 'success', 0).length, 0);
  assert.equal(exercise(['validate', 'publish'], 'success', 0).length, 0);
  let trace = exercise(['publish'], 'reuse', 0);
  assert.ok(!trace.some(row => row.args[0] === 'build' || row.args[0] === 'push'));
  assert.ok(trace.some(row => row.args[0] === 'image'));
  assert.equal(readFileSync(join(directory, 'canary-evidence/canary-image.txt'), 'utf8'), image + '\n');
  assert.equal(existsSync(join(directory, 'image.txt')), false);
  console.log('PASS source-SHA image reuse checks purpose and revision without producing a normal promotion artifact');
  for (const scenario of ['new-image', 'new-image-cli']) {
    trace = exercise(['publish'], scenario, 0);
    const build = trace.find(row => row.args[0] === 'build');
    assert.ok(build.args.includes('local-lab/Dockerfile.runtime'));
    assert.ok(build.args.includes('RELEASE_SHA=' + sha));
    assert.ok(build.args.includes('io.gospel.image-purpose=canary'));
    assert.ok(build.args.includes('linux/amd64'));
    assert.ok(trace.find(row => row.args[0] === 'push').args.includes('linux/amd64'));
    assert.ok(!trace.some(row => row.args.includes('content-check')));
    assert.ok(!trace.some(row => row.args[0] === 'run'));
  }
  console.log('PASS publication uses the normal runtime Dockerfile in the distinct canary repository without executing the canary');
  writeFileSync(join(directory, 'dirty'), 'change');
  assert.equal(exercise(['publish'], 'dirty', 1).length, 0); rmSync(join(directory, 'dirty'));
  for (const scenario of ['wrong-revision', 'wrong-purpose']) {
    trace = exercise(['execute'], scenario, 1);
    assert.ok(!trace.some(row => row.name === 'gcloud'));
  }
  console.log('PASS clean source and image labels are checked before execution mutation');
  trace = exercise(['execute'], 'success', 0);
  const mutations = trace.filter(row => row.name === 'gcloud' && ['update', 'execute'].includes(row.args[2]));
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every(row => row.args[3] === 'gospel-staging-canary'));
  assert.ok(mutations[0].args.includes('--args=dist/canary.js'));
  assert.ok(mutations.every(row => !row.args.some(arg => /secret|migration|migrate/.test(arg))));
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'canary-evidence/success.json'), 'utf8')), { event: 'canary_execution_succeeded', execution, image, revision: sha, success: true });
  assert.equal(existsSync(join(directory, 'image.txt')), false);
  console.log('PASS execution updates and runs only the fixed canary job and stores allowlisted execution metadata');
  trace = exercise(['execute'], 'initially-pending', 0);
  assert.equal(trace.filter(row => row.args[2] === 'executions').length, 2);
  for (const scenario of ['launch-fails', 'failed-execution', 'wrong-job', 'wrong-image', 'wrong-command', 'pending-forever', 'raw-error']) {
    trace = exercise(['execute'], scenario, 1);
    assert.equal(existsSync(join(directory, 'canary-evidence/success.json')), false);
    if (scenario === 'pending-forever') assert.equal(trace.filter(row => row.args[2] === 'executions').length, 60);
  }
  console.log('PASS failed, mismatched and timed-out executions cannot produce success; raw CLI errors stay out of artifacts');
} finally { rmSync(directory, { recursive: true, force: true }); }
