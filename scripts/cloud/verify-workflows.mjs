import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'gospel-cloud-tests-'));
const digest = 'sha256:' + 'b'.repeat(64);
const stub = `#!/usr/bin/env node
const fs=require('node:fs');const path=require('node:path');
const name=path.basename(process.argv[1]);const args=process.argv.slice(2);const scenario=process.env.SCENARIO;
fs.appendFileSync(process.env.TRACE,JSON.stringify({name,args})+'\\n');
if(name==='gcloud'){
 if(args[0]==='artifacts'){
  if(scenario==='new-image'&&!fs.existsSync(process.env.PUSHED)){console.error('NOT_FOUND');process.exit(1)}
  console.log('${digest}');
 }else if(args[0]==='scheduler')console.log(scenario==='active-schedule'?'ENABLED':'PAUSED');
 else if(args[0]==='run'&&args[1]==='services'&&args[2]==='describe')console.log('https://status.invalid');
 else if(args[0]==='auth'&&args[1]==='print-identity-token')console.log('synthetic-identity-token');
 if(scenario==='migration-fails'&&args.includes('execute')&&args.includes('gospel-staging-migrate'))process.exit(1);
}else if(name==='docker'){
 if(args[0]==='run'&&scenario==='invalid-content')process.exit(1);
 if(args[0]==='push')fs.writeFileSync(process.env.PUSHED,'pushed');
}else if(name==='curl'){
 if(args.includes('--write-out'))process.stdout.write(scenario==='public-status'?'200':'403');
 else console.log(JSON.stringify({ok:true}));
}
`;
try {
  for (const command of ['gcloud', 'docker', 'curl']) writeFileSync(join(directory, command), stub, { mode: 0o755 });
  function exercise(script, scenario, expected) {
    const trace = join(directory, 'trace.jsonl');
    const pushed = join(directory, 'pushed');
    writeFileSync(trace, ''); rmSync(pushed, { force: true });
    writeFileSync(join(directory, 'image.txt'), `us-central1-docker.pkg.dev/test-project/gospel/runtime@${digest}\n`);
    const result = spawnSync('/bin/bash', [fileURLToPath(new URL(script, import.meta.url))], {
      cwd: directory, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, APP_ENV: 'staging', GCP_PROJECT_ID: 'test-project', REGION: 'us-central1', GITHUB_SHA: 'a'.repeat(40), SCENARIO: scenario, TRACE: trace, PUSHED: pushed },
    });
    assert.equal(result.status, expected, JSON.stringify({ scenario, stdout: result.stdout, stderr: result.stderr, trace: readFileSync(trace, 'utf8') }));
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
  trace = exercise('build.sh', 'invalid-content', 1);
  assert.ok(!trace.some(row => row.name === 'docker' && row.args[0] === 'push'));
  console.log('PASS bad content prevents publication');
  trace = exercise('release.sh', 'paused', 0);
  const migrated = trace.findIndex(row => row.name === 'gcloud' && row.args.includes('execute') && row.args.includes('gospel-staging-migrate'));
  const updated = trace.findIndex(row => row.name === 'gcloud' && row.args[1] === 'services' && row.args.includes('update'));
  assert.ok(migrated >= 0 && updated > migrated);
  console.log('PASS migration precedes status deployment and authenticated smoke');
  for (const scenario of ['active-schedule', 'migration-fails']) {
    trace = exercise('release.sh', scenario, 1);
    assert.ok(!trace.some(row => row.name === 'gcloud' && row.args[1] === 'services' && row.args.includes('update')));
    if (scenario === 'active-schedule') assert.ok(!trace.some(row => row.name === 'gcloud' && row.args.includes('update')));
    console.log('PASS ' + scenario + ' stops deployment');
  }
  exercise('release.sh', 'public-status', 1);
  console.log('PASS public status access fails the release smoke check');
} finally { rmSync(directory, { recursive: true, force: true }); }
