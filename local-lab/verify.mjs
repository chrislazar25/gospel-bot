import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const evidenceRoot = join(root, 'evidence');
mkdirSync(evidenceRoot, { recursive: true });
const latest = process.env.LAB_RUN_STATE ?? join(evidenceRoot, 'latest.json');
let state;
let report = { checks: [], startedAt: new Date().toISOString() };
let failed = false;
function save() { writeFileSync(join(state.directory, 'report.json'), JSON.stringify(report, null, 2)); }
function compose(args) {
  return execFileSync('docker', ['compose', '-p', state.project, '-f', join(root, 'compose.yaml'), ...args], { cwd: root, env: { ...process.env, ...state.environment }, encoding: 'utf8', maxBuffer: 10_000_000 });
}
function check(name, value) {
  assert(value, name);
  report.checks.push(name);
  save();
  process.stdout.write(`PASS ${name}\n`);
}
async function request(base, path, data) {
  const response = await fetch(base + path, { ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }), signal: AbortSignal.timeout(5000) });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value;
}
async function ready() {
  for (let i = 0; i < 60; i++) {
    try {
      for (const base of state.apps) assert.equal((await request(base, '/health')).kind, 'local simulator lab');
      assert.equal((await request(state.fake, '/health')).kind, 'simulator contract; not verified GreenAPI');
      return;
    } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw new Error('lab health timed out');
}
async function doctor(owned = true) {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
  process.stdout.write(execFileSync('docker', ['compose', 'version'], { encoding: 'utf8' }));
  if (!owned) return;
  try { state = JSON.parse(readFileSync(latest, 'utf8')); } catch { process.stdout.write('Prerequisites ready; no helper run selected.\n'); return; }
  if (state.cleaned) { process.stdout.write('Prerequisites ready; selected helper run was cleaned.\n'); return; }
  assert.match(state.project, /^gospel-lab-[0-9a-f]{8}$/);
  const services = JSON.parse(compose(['ps', '--format', 'json', '--all']).split('\n').filter(Boolean).map(line => line).join(',').replace(/^/, '[').replace(/$/, ']'));
  assert.equal(services.length, 5, 'owned Compose project has all five services');
  await ready();
  process.stdout.write('Owned project, initialized schema, and all public health endpoints ready.\n');
}
async function launch() {
  try {
    const selected = JSON.parse(readFileSync(latest, 'utf8'));
    assert.equal(selected?.cleaned, true, `Selected helper run ${selected?.project ?? '(unknown project)'} at ${latest} is not cleaned; run cleanup before launching again`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const project = `gospel-lab-${randomUUID().slice(0, 8)}`;
  const directory = join(evidenceRoot, project);
  mkdirSync(directory);
  const config = join(directory, 'config');
  mkdirSync(config);
  writeFileSync(join(config, 'clock.json'), readFileSync(join(root, 'config', 'clock.json')));
  const content = join(directory, 'content');
  cpSync(join(root, 'content'), content, { recursive: true });
  state = { project, directory, environment: { APP1_PORT: '0', APP2_PORT: '0', FAKE_PORT: '0', LAB_CONFIG_DIR: config, LAB_CONTENT_DIR: content } };
  writeFileSync(latest, JSON.stringify(state));
  compose(['up', '--build', '-d']);
  const address = port => `http://${compose(['port', 'ingress', String(port)]).trim()}`;
  state.apps = [address(3001), address(3002)];
  state.fake = address(3003);
  writeFileSync(latest, JSON.stringify(state));
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state, null, 2));
  await ready();
  check('two apps, fake provider, and PostgreSQL ready', true);
  process.stdout.write(`Evidence ${directory}\n`);
}
async function drive() {
  await ready();
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => request(state.apps[i % 2], '/send-todays-message', {})));
  const id = results[0].id;
  check('concurrent replicas share one daily UUID', results.every(row => row.id === id));
  const accepted = await request(state.apps[0], `/get-status/${id}`);
  check('provider acceptance is not confirmation', accepted.status === 'accepted' && accepted.attempts === 1 && accepted.provider_id);
  const source = join(state.environment.LAB_CONTENT_DIR, `${accepted.date}.txt`);
  const original = readFileSync(source);
  writeFileSync(source, 'SYNTHETIC changed fixture after claim.\n');
  const again = await request(state.apps[1], '/send-todays-message', {});
  writeFileSync(source, original);
  check('repeated POST preserves payload and hash', again.payload === accepted.payload && again.payload_hash === accepted.payload_hash);
  await Promise.all(state.apps.map(base => request(base, `/get-status/${id}`)));
  const sent = await request(state.fake, '/admin/requests');
  check('one external send after concurrent POSTs, repeated POST, and GETs', sent.length === 1 && sent[0].accepted && sent[0].payload === accepted.payload);
  for (const [path, options, expected] of [
    ['/send-todays-message', { method: 'GET' }, 405],
    ['/send-todays-message', { method: 'POST', body: 'broken' }, 400],
    ['/send-todays-message', { method: 'POST', body: '{"target":"other"}' }, 400],
    ['/get-status/broken', {}, 400],
    ['/absent', {}, 404],
  ]) {
    const response = await fetch(state.apps[0] + path, { ...options, signal: AbortSignal.timeout(5000) });
    check(`HTTP boundary ${path} returns ${expected}`, response.status === expected);
  }
  report.delivery = accepted;
  report.externalRequests = sent;
  save();
  await faults();
}
function sql(statement) {
  return compose(['exec', '-T', 'db', 'psql', '-U', 'lab', '-d', 'lab', '-At', '-v', 'ON_ERROR_STOP=1', '-c', statement]).trim();
}
function clock(now) { writeFileSync(join(state.environment.LAB_CONFIG_DIR, 'clock.json'), JSON.stringify({ now })); }
async function reset(mode) {
  assert.match(state.project, /^gospel-lab-[0-9a-f]{8}$/);
  sql('TRUNCATE deliveries,delivery_evidence,simulator.requests;');
  clock('2026-10-27T18:29:59.000Z');
  await request(state.fake, '/admin/control', { mode });
}
async function snapshot(name) {
  report.scenarios ??= {};
  report.scenarios[name] = {
    deliveries: JSON.parse(sql("SELECT coalesce(json_agg(d),'[]') FROM deliveries d")),
    evidence: JSON.parse(sql("SELECT coalesce(json_agg(e),'[]') FROM delivery_evidence e")),
    externalRequests: await request(state.fake, '/admin/requests'),
  };
  save();
}
async function restart() {
  compose(['restart', 'db']);
  await ready();
  check('database-only restart recovers idle pooled clients', true);
  compose(['restart', 'app1', 'app2', 'fake']);
  await ready();
}
async function faults() {
  const post = base => request(base ?? state.apps[0], '/send-todays-message', {});
  const get = id => request(state.apps[1], `/get-status/${id}`);
  const external = () => request(state.fake, '/admin/requests');
  await snapshot('concurrent-and-frozen');
  await reset('reject');
  const rejected = await post();
  check('explicit simulator rejection permits retry', rejected.status === 'pending' && rejected.attempts === 1 && rejected.provider_id === null);
  await request(state.fake, '/admin/control', { mode: 'success' });
  const retried = await post();
  check('proven rejection retry uses same frozen record', retried.id === rejected.id && retried.status === 'accepted' && retried.attempts === 2 && retried.payload_hash === rejected.payload_hash);
  check('rejected attempt was not accepted externally', (await external()).filter(row => row.accepted).length === 1);
  await snapshot('rejection-then-retry');
  for (const mode of ['generic500', 'malformed', 'timeout', 'accept-drop']) {
    await reset(mode);
    const uncertain = await post();
    check(`${mode} leaves durable unknown`, uncertain.status === 'unknown' && uncertain.provider_id === null && uncertain.attempts === 1);
    if (mode === 'accept-drop') {
      const acceptedElsewhere = (await external())[0];
      await request(state.fake, '/admin/confirm', { providerId: acceptedElsewhere.id });
      await restart();
    }
    const repeats = await Promise.all([post(state.apps[0]), post(state.apps[1]), get(uncertain.id)]);
    check(`${mode} repeated POST and GET never resend or infer confirmation`, repeats.every(row => row.id === uncertain.id && row.status === 'unknown' && row.attempts === 1) && (await external()).length === 1);
    if (mode !== 'generic500') check(`${mode} external acceptance remains independent evidence`, (await external())[0].accepted);
    await snapshot(mode);
  }
  await reset('success');
  sql("CREATE FUNCTION reject_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected accepted bookkeeping failure'; END $$; CREATE TRIGGER reject_accept BEFORE UPDATE ON deliveries FOR EACH ROW WHEN (NEW.status='accepted') EXECUTE FUNCTION reject_accept();");
  const bookkeeping = await post();
  sql('DROP TRIGGER reject_accept ON deliveries; DROP FUNCTION reject_accept();');
  check('accepted HTTP with failed database bookkeeping remains unknown', bookkeeping.status === 'unknown' && bookkeeping.provider_id === null && (await external())[0].accepted);
  const stillUnknown = await post();
  check('bookkeeping failure never retries accepted external send', stillUnknown.status === 'unknown' && stillUnknown.attempts === 1 && (await external()).length === 1);
  await snapshot('accepted-bookkeeping-failure');
  await reset('delayed');
  const delayed = await post();
  check('sent receipt leaves accepted unconfirmed', delayed.status === 'accepted' && (await get(delayed.id)).status === 'accepted');
  await request(state.fake, '/admin/confirm', { providerId: delayed.provider_id });
  const confirmed = await get(delayed.id);
  check('delivered receipt confirms known provider ID', confirmed.status === 'confirmed' && confirmed.evidence === 'receipt:delivered');
  await restart();
  const durable = await get(delayed.id);
  check('app fake and database restart preserve confirmation and payload', durable.status === 'confirmed' && durable.provider_id === confirmed.provider_id && durable.payload_hash === confirmed.payload_hash);
  await post();
  check('confirmed POST and GET never send again', (await external()).length === 1);
  await snapshot('delayed-receipt-and-restarts');
  await reset('success');
  const before = await post();
  clock('2026-10-27T18:30:00.000Z');
  const after = await post(state.apps[1]);
  clock('2026-10-28T18:30:00.000Z');
  const third = await post();
  check('IST midnight advances daily key independently of UTC day', before.date === '2026-10-27' && after.date === '2026-10-28' && third.date === '2026-10-29' && before.id !== after.id && after.id !== third.id);
  check('three fixture dates freeze distinct synthetic content', new Set([before.payload_hash, after.payload_hash, third.payload_hash]).size === 3 && (await external()).length === 3);
  await snapshot('ist-midnight');
}
function cleanup() {
  if (!state || state.cleaned) return;
  assert.match(state.project, /^gospel-lab-[0-9a-f]{8}$/);
  try { writeFileSync(join(state.directory, 'compose.log'), compose(['logs', '--no-color'])); }
  finally {
    try {
      compose(['down', '--volumes', '--remove-orphans']);
      state.cleaned = true;
      report.cleanedAt = new Date().toISOString();
      if (JSON.parse(readFileSync(latest, 'utf8')).project === state.project) writeFileSync(latest, JSON.stringify(state));
      writeFileSync(join(state.directory, 'state.json'), JSON.stringify(state, null, 2));
    } catch (error) { report.cleanupError = String(error); throw error; }
    finally { save(); }
  }
}
const stage = process.argv[2] ?? 'all';
try {
  if (stage === 'doctor') await doctor();
  else if (stage === 'launch') { await doctor(false); await launch(); }
  else if (stage === 'all') { await doctor(false); await launch(); await drive(); }
  else {
    state = JSON.parse(readFileSync(latest, 'utf8'));
    try { report = JSON.parse(readFileSync(join(state.directory, 'report.json'), 'utf8')); }
    catch (error) { if (stage !== 'cleanup' || error.code !== 'ENOENT') throw error; }
    if (stage === 'drive') await drive();
    else if (stage === 'cleanup') cleanup();
    else throw new Error('stage must be doctor, launch, drive, cleanup, or all');
  }
} catch (error) {
  failed = true;
  report.error = String(error);
  if (state) save();
  process.exitCode = 1;
  process.stderr.write(`${error}\n`);
} finally {
  if (stage === 'all' || (failed && ['launch', 'drive'].includes(stage))) cleanup();
}
