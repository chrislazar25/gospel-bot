import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'gospel-cloud-tests-'));
const digest = 'sha256:' + 'b'.repeat(64);
const image = `us-central1-docker.pkg.dev/test-project/gospel/runtime@${digest}`;
const stub = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const name=path.basename(process.argv[1]);const args=process.argv.slice(2);const scenario=process.env.SCENARIO;
fs.appendFileSync(process.env.TRACE,JSON.stringify({name,args})+'\\n');
if(name==='gcloud'){
 if(args[0]==='artifacts'){
  if(scenario.startsWith('new-image')&&!fs.existsSync(process.env.PUSHED)){console.error(scenario==='new-image-cli'?'Image not found.':'NOT_FOUND');process.exit(1)}
  console.log('${digest}');
 }else if(args[0]==='scheduler')console.log(scenario==='active-schedule'?'ENABLED':'PAUSED');
 else if(args[0]==='run'&&args[1]==='services'&&args[2]==='describe')console.log('https://status.invalid');
 else if(args[0]==='auth'&&args[1]==='print-identity-token'){console.error('unsupported external credentials');process.exit(1)}
 if(scenario==='migration-fails'&&args.includes('execute')&&args.includes('gospel-staging-migrate'))process.exit(1);
}else if(name==='docker'){
 if(args[0]==='run'&&scenario==='invalid-content')process.exit(1);
 if(args[0]==='push')fs.writeFileSync(process.env.PUSHED,'pushed');
}else if(name==='curl'){
 if(args.includes('--write-out'))process.stdout.write(scenario==='public-status'?'200':'403');
 else if(args.includes('Authorization: Bearer synthetic-identity-token')){
  if(scenario==='invalid-token')process.exit(22);
  console.log(JSON.stringify({ok:true}));
 }else process.exit(22);
}else if(name==='gh'){
 if(args[0]==='api')console.log(JSON.stringify({
  conclusion:scenario==='failed-run'?'failure':'success',event:scenario==='wrong-event'?'push':'workflow_dispatch',
  head_branch:scenario==='wrong-branch'?'feature':'master',head_sha:scenario==='wrong-sha'?'c'.repeat(40):process.env.GITHUB_SHA,
  path:scenario==='wrong-workflow'?'.github/workflows/ci.yml':'.github/workflows/release.yml'
 }));
 else if(args[0]==='run'&&args[1]==='download'){
  if(scenario==='candidate-only'||scenario==='missing-artifact')process.exit(1);
  if(args[args.indexOf('--name')+1]!=='tested-staging-image')process.exit(1);
  const dir=args[args.indexOf('--dir')+1];fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'environment.txt'),scenario==='wrong-environment'?'production':'staging');
  if(scenario!=='missing-digest')fs.writeFileSync(path.join(dir,'image.txt'),scenario==='bad-digest'?'runtime:latest':'${image}');
 }
}
`;
try {
  for (const command of ['gcloud', 'docker', 'curl', 'gh']) writeFileSync(join(directory, command), stub, { mode: 0o755 });
  function exercise(script, scenario, expected, overrides = {}) {
    const trace = join(directory, 'trace.jsonl');
    const pushed = join(directory, 'pushed');
    const output = join(directory, 'github-output');
    writeFileSync(trace, ''); rmSync(pushed, { force: true }); writeFileSync(output, '');
    writeFileSync(join(directory, 'image.txt'), script === 'promote.sh' ? 'unpromoted\n' : `${image}\n`);
    const result = spawnSync('/bin/bash', [fileURLToPath(new URL(script, import.meta.url))], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: {
        ...process.env, PATH: directory + ':' + process.env.PATH, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project', REGION: 'us-central1',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_OUTPUT: output, SCENARIO: scenario, TRACE: trace, PUSHED: pushed,
        STATUS_URL: 'https://status.invalid', ID_TOKEN: 'synthetic-identity-token', STAGING_RUN: '123', GH_REPO: 'example/gospel', ...overrides,
      },
    });
    assert.equal(result.status, expected, JSON.stringify({ script, scenario, stdout: result.stdout, stderr: result.stderr, trace: readFileSync(trace, 'utf8') }));
    return readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
  let trace = exercise('build.sh', 'reuse-image', 0);
  assert.ok(!trace.some(row => row.name === 'docker' && row.args[0] === 'build'));
  assert.ok(trace.some(row => row.name === 'docker' && row.args.includes('APP_ENV')));
  console.log('PASS existing immutable image is validated and reused');
  trace = exercise('build.sh', 'new-image', 0);
  assert.ok(trace.some(row => row.name === 'docker' && row.args.includes('RELEASE_SHA=' + 'a'.repeat(40))));
  assert.ok(trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  console.log('PASS new image carries its source revision before publication');
  trace = exercise('build.sh', 'new-image-cli', 0);
  assert.ok(trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  console.log('PASS first build accepts the actual CLI missing-image message');
  trace = exercise('build.sh', 'invalid-content', 1);
  assert.ok(!trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  console.log('PASS bad content prevents publication');
  trace = exercise('release.sh', 'paused', 0);
  const migrated = trace.findIndex(row => row.name === 'gcloud' && row.args.includes('execute') && row.args.includes('gospel-staging-migrate'));
  const updated = trace.findIndex(row => row.name === 'gcloud' && row.args[1] === 'services' && row.args.includes('update'));
  assert.ok(migrated >= 0 && updated > migrated);
  assert.equal(readFileSync(join(directory, 'github-output'), 'utf8'), 'status_url=https://status.invalid\n');
  assert.ok(!trace.some(row => row.args.includes('print-identity-token')));
  assert.ok(!trace.some(row => row.name === 'curl'));
  console.log('PASS deployment emits the actual service URL for the auth action');
  for (const scenario of ['active-schedule', 'migration-fails']) {
    trace = exercise('release.sh', scenario, 1);
    assert.ok(!trace.some(row => row.name === 'gcloud' && row.args[1] === 'services' && row.args.includes('update')));
    if (scenario === 'active-schedule') assert.ok(!trace.some(row => row.name === 'gcloud' && row.args.includes('update')));
    console.log('PASS ' + scenario + ' stops deployment');
  }
  trace = exercise('smoke.sh', 'private-status', 0);
  assert.ok(trace.some(row => row.name === 'curl' && row.args.includes('Authorization: Bearer synthetic-identity-token')));
  assert.ok(trace.at(-1).args.includes('gospel-staging-check'));
  console.log('PASS smoke uses the supplied ID token before the check job');
  for (const scenario of ['public-status', 'invalid-token']) {
    trace = exercise('smoke.sh', scenario, scenario === 'invalid-token' ? 22 : 1);
    assert.ok(!trace.some(row => row.name === 'gcloud'));
    console.log('PASS ' + scenario + ' stops the release smoke check');
  }
  trace = exercise('smoke.sh', 'missing-token', 1, { ID_TOKEN: '' });
  assert.equal(trace.length, 0);
  console.log('PASS missing token fails before any smoke request');
  exercise('promote.sh', 'tested-staging', 0, { APP_ENV: 'production' });
  assert.equal(readFileSync(join(directory, 'image.txt'), 'utf8'), image + '\n');
  console.log('PASS successful staging run promotes its tested immutable digest');
  for (const scenario of ['failed-run', 'wrong-sha', 'candidate-only', 'missing-artifact', 'wrong-event', 'wrong-branch', 'wrong-workflow', 'wrong-environment', 'missing-digest', 'bad-digest']) {
    trace = exercise('promote.sh', scenario, 1, { APP_ENV: 'production' });
    assert.equal(readFileSync(join(directory, 'image.txt'), 'utf8'), 'unpromoted\n');
    if (['failed-run', 'wrong-sha', 'wrong-event', 'wrong-branch', 'wrong-workflow'].includes(scenario)) {
      assert.ok(!trace.some(row => row.args.includes('download')));
    }
    console.log('PASS promotion rejects ' + scenario);
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
