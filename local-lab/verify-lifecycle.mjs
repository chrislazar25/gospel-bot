import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const evidence = join(root, 'evidence');
mkdirSync(evidence, { recursive: true });
const directory = mkdtempSync(join(evidence, 'lifecycle-'));
const latest = join(directory, 'selected.json');
const driver = process.argv[2] ?? join(root, 'verify.mjs');
const snapshots = new Map();
const proof = {};
let invocation = 0;
function run(stage, refused = false, selector = latest) {
  const result = spawnSync(process.execPath, [driver, stage], { env: { ...process.env, LAB_RUN_STATE: selector }, encoding: 'utf8' });
  writeFileSync(join(directory, `${++invocation}-${stage}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
  try {
    const bytes = readFileSync(selector);
    const selected = JSON.parse(bytes);
    if (selected.project && !snapshots.has(selected.project)) snapshots.set(selected.project, bytes);
  } catch {}
  assert.equal(result.error, undefined);
  if (refused) assert.notEqual(result.status, 0, `${stage} must refuse an uncleaned or corrupt selector`);
  else assert.equal(result.status, 0, `${stage} failed; see ${directory}`);
}
const selected = () => JSON.parse(readFileSync(latest));
const projects = () => readdirSync(evidence).filter(name => /^gospel-lab-/.test(name)).sort();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes = state => Object.fromEntries(['compose.log', 'report.json', 'state.json'].map(name => [name, hash(join(state.directory, name))]).concat([['selected.json', hash(latest)]]));
const resources = project => ['container', 'network', 'volume'].map(kind => execFileSync('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=com.docker.compose.project=${project}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort());
try {
  run('launch');
  const first = selected();
  const selectorHash = hash(latest);
  const reportHash = hash(join(first.directory, 'report.json'));
  const beforeProjects = projects();
  const beforeResources = resources(first.project);
  proof.first = { project: first.project, selectorHash, reportHash, resources: beforeResources };
  for (const stage of ['launch', 'all']) {
    run(stage, true);
    assert.equal(hash(latest), selectorHash, 'refusal preserves selected state bytes');
    assert.equal(hash(join(first.directory, 'report.json')), reportHash, 'refusal preserves report');
    assert.deepEqual(projects(), beforeProjects, 'refusal creates no project');
    assert.deepEqual(resources(first.project), beforeResources, 'refusal preserves project resources');
    for (const base of [...first.apps, first.fake]) assert.equal((await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).status, 200);
  }
  run('drive');
  run('cleanup');
  const cleanedHashes = hashes(first);
  run('cleanup');
  assert.deepEqual(hashes(first), cleanedHashes, 'repeated cleanup preserves logs, report, state and selector bytes');
  assert.deepEqual(resources(first.project), [[], [], []], 'cleanup removes exact project resources');
  proof.cleanup = { before: cleanedHashes, after: hashes(first), logBytes: readFileSync(join(first.directory, 'compose.log')).length, resources: resources(first.project) };
  run('launch');
  assert.notEqual(selected().project, first.project, 'cleaned selector permits a new project');
  proof.relaunched = selected().project;
  run('cleanup');
  assert.deepEqual(resources(selected().project), [[], [], []]);
  writeFileSync(latest, '{broken');
  const beforeCorrupt = projects();
  run('launch', true);
  run('all', true);
  assert.equal(readFileSync(latest, 'utf8'), '{broken');
  assert.deepEqual(projects(), beforeCorrupt, 'corrupt selector creates no project');
  writeFileSync(join(directory, 'report.json'), JSON.stringify(proof, null, 2));
  process.stdout.write(`PASS helper lifecycle regression; evidence ${directory}\n`);
} finally {
  for (const [project, bytes] of snapshots) {
    if (resources(project).every(ids => ids.length === 0)) continue;
    const recovery = join(directory, `${project}.json`);
    writeFileSync(recovery, bytes);
    run('cleanup', false, recovery);
  }
}
