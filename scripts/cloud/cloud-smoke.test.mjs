import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'gospel-smoke-tests-'));
const digest = 'sha256:' + 'b'.repeat(64);
const image = `us-central1-docker.pkg.dev/test-project/gospel/cloud-smoke@${digest}`;
const execution = 'gospel-staging-cloud-smoke-abc12';
const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = process.env.SCENARIO;
fs.appendFileSync(process.env.TRACE, JSON.stringify({name, args}) + '\\n');
if (name === 'docker' && args[0] === 'run' && scenario === 'local-fails') process.exit(1);
if (name === 'docker' && args[0] === 'run' && scenario !== 'missing-proof') console.log(JSON.stringify({
  event: 'cloud_smoke_verified', revision: scenario === 'wrong-proof-revision' ? 'c'.repeat(40) : process.env.GITHUB_SHA,
  execution: null, provider: 'loopback-simulator', submissions: 1, attempts: 1, status: 'confirmed', cleanup: true,
}));
if (name === 'docker' && args[0] === 'image' && args[1] === 'inspect') console.log(JSON.stringify({
  'org.opencontainers.image.revision': scenario === 'wrong-label-revision' ? 'c'.repeat(40) : process.env.GITHUB_SHA,
  'io.gospel.image-purpose': scenario === 'wrong-purpose' ? 'runtime' : 'cloud-smoke',
}));
if (name === 'docker' && args[0] === 'push') fs.writeFileSync(process.env.PUSHED, 'pushed');
if (name === 'gcloud') {
  if (args[0] === 'artifacts') {
    if (scenario.startsWith('new-image') && !fs.existsSync(process.env.PUSHED)) {console.error(scenario === 'new-image-cli' ? 'Image not found.' : 'NOT_FOUND'); process.exit(1);}
    console.log('${digest}');
  }
  if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'execute') {
    if (scenario === 'execute-fails') process.exit(1);
    console.log('${execution}');
  }
  if (args[0] === 'run' && args[1] === 'jobs' && args[2] === 'executions') {
    const describes = fs.readFileSync(process.env.TRACE, 'utf8').trim().split('\\n').map(line => JSON.parse(line)).filter(row => row.name === 'gcloud' && row.args[2] === 'executions').length;
    const pending = scenario === 'initially-pending' && describes === 1;
    console.log(JSON.stringify({
      metadata: {name: '${execution}', labels: {'run.googleapis.com/job': scenario === 'wrong-job' ? 'gospel-staging-send' : 'gospel-staging-cloud-smoke'}},
      spec: {taskCount: 1, template: {spec: {containers: [{image: scenario === 'wrong-image' ? 'runtime:latest' : '${image}',
        command: scenario === 'wrong-command' ? ['/bin/true'] : ['node'], args: ['/verification/run.mjs']}]}}},
      status: {succeededCount: scenario === 'failed-execution' ? 0 : 1, failedCount: scenario === 'failed-execution' ? 1 : 0,
        conditions: [{type: 'Completed', status: pending ? 'Unknown' : scenario === 'failed-execution' ? 'False' : 'True'}]},
    }));
  }
}
`;
try {
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  for (const name of ['docker', 'gcloud', 'sleep']) writeFileSync(join(directory, name), stub, { mode: 0o755 });
  writeFileSync(join(directory, '.gitignore'), 'cloud-smoke-evidence/\nsmoke-image.txt\ntrace.jsonl\npushed\n');
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Smoke test', '-c', 'user.email=smoke@example.invalid', 'commit', '--quiet', '-m', 'Fixture');
  const sha = git('rev-parse', 'HEAD');
  function exercise(mode, scenario, expected, overrides = {}) {
    const trace = join(directory, 'trace.jsonl');
    writeFileSync(trace, '');
    rmSync(join(directory, 'pushed'), {force: true});
    writeFileSync(join(directory, 'smoke-image.txt'), scenario === 'wrong-scope'
      ? image.replace('test-project', 'other-project') : scenario === 'mutable-image' ? image.replace('@' + digest, ':latest') : image);
    const result = spawnSync('/bin/bash', [fileURLToPath(new URL('cloud-smoke.sh', import.meta.url)), mode], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project',
        REGION: 'us-central1', PUSHED: join(directory, 'pushed'), GITHUB_SHA: sha, SCENARIO: scenario, TRACE: trace, ...overrides },
    });
    assert.equal(result.status, expected, JSON.stringify({mode, scenario, stdout: result.stdout, stderr: result.stderr}));
    return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  for (const mode of ['local', 'publish', 'execute']) {
    assert.equal(exercise(mode, 'production', 1, { APP_ENV: 'production' }).length, 0);
  }
  console.log('PASS production fails before Docker or gcloud');
  let trace = exercise('local', 'success', 0);
  assert.equal(trace.filter(row => row.args[0] === 'build').length, 2);
  assert.ok(trace.find(row => row.args[0] === 'build').args.includes('RELEASE_SHA=' + sha));
  assert.ok(trace.some(row => row.args.includes('--network') && row.args.includes('none')));
  assert.ok(trace.every(row => row.name === 'docker'));
  console.log('PASS local mode builds the runtime derivative and runs without a network');
  trace = exercise('publish', 'local-fails', 1);
  assert.ok(!trace.some(row => row.name === 'gcloud' || row.args[0] === 'push'));
  console.log('PASS failed local proof prevents cloud publication');
  for (const scenario of ['wrong-proof-revision', 'missing-proof']) {
    trace = exercise('publish', scenario, 1);
    assert.ok(!trace.some(row => row.name === 'gcloud' || row.args[0] === 'push'));
  }
  console.log('PASS missing proof or a different runtime revision prevents publication');
  writeFileSync(join(directory, 'uncommitted'), 'change');
  assert.equal(exercise('publish', 'dirty-source', 1).length, 0);
  rmSync(join(directory, 'uncommitted'));
  assert.equal(exercise('publish', 'wrong-sha', 1, { GITHUB_SHA: 'c'.repeat(40) }).length, 0);
  console.log('PASS publication requires clean committed source at the claimed revision');
  trace = exercise('publish', 'success', 0);
  assert.ok(trace.findIndex(row => row.args[0] === 'run') < trace.findIndex(row => row.name === 'gcloud'));
  assert.equal(readFileSync(join(directory, 'smoke-image.txt'), 'utf8'), image + '\n');
  console.log('PASS publication reuses and rechecks an existing immutable smoke image');
  trace = exercise('publish', 'new-image', 0);
  assert.ok(trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  assert.ok(trace.find(row => row.name === 'docker' && row.args[0] === 'push').args.includes('--platform'));
  assert.ok(trace.find(row => row.name === 'docker' && row.args[0] === 'push').args.includes('linux/amd64'));
  assert.ok(trace.findIndex(row => row.args[0] === 'run') < trace.findIndex(row => row.args[0] === 'push'));
  console.log('PASS new publication requires local proof before pushing a separate pinned smoke image');
  trace = exercise('publish', 'new-image-cli', 0);
  assert.ok(trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  console.log('PASS the real gcloud missing-image message permits first publication');
  for (const scenario of ['wrong-scope', 'mutable-image']) {
    trace = exercise('execute', scenario, 1);
    assert.equal(trace.length, 0, JSON.stringify({scenario, trace}));
  }
  console.log('PASS execution rejects another project or a mutable tag before gcloud');
  for (const scenario of ['wrong-label-revision', 'wrong-purpose']) {
    trace = exercise('execute', scenario, 1);
    assert.ok(!trace.some(row => row.name === 'gcloud'));
  }
  console.log('PASS execution verifies the image revision and smoke purpose before cloud mutation');
  trace = exercise('execute', 'success', 0);
  const mutations = trace.filter(row => row.args[0] === 'run' && ['update', 'execute'].includes(row.args[2]));
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every(row => row.args[3] === 'gospel-staging-cloud-smoke'));
  assert.ok(mutations[0].args.includes('--image=' + image));
  assert.ok(mutations[0].args.includes('--command=node') && mutations[0].args.includes('--args=/verification/run.mjs'));
  assert.ok(mutations[1].args.includes('--async'));
  const success = JSON.parse(readFileSync(join(directory, 'cloud-smoke-evidence/success.json'), 'utf8'));
  assert.deepEqual(success, {execution, image, checkout_revision: sha, success: true});
  console.log('PASS only the fixed smoke job is updated and successful execution evidence names its pinned image');
  trace = exercise('execute', 'initially-pending', 0);
  assert.equal(trace.filter(row => row.name === 'gcloud' && row.args[2] === 'executions').length, 2);
  console.log('PASS a pending execution is observed again before success');
  for (const scenario of ['execute-fails', 'failed-execution', 'wrong-command', 'wrong-image', 'wrong-job']) {
    exercise('execute', scenario, 1);
    assert.equal(existsSync(join(directory, 'cloud-smoke-evidence/success.json')), false);
    if (scenario !== 'execute-fails') assert.equal(existsSync(join(directory, 'cloud-smoke-evidence/execution.json')), true);
    console.log('PASS ' + scenario + ' cannot leave successful execution evidence');
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
