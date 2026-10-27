import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(process.argv[2] || fileURLToPath(new URL('../', import.meta.url)));
const base = fileURLToPath(new URL('./evidence/', import.meta.url));
const id = randomUUID().slice(0, 8);
const project = `gospel-image-verify-${id}`;
const image = `gospel-runtime:verify-${id}`;
const runDir = `${base}/${project}`;
const tlsDir = `${runDir}/tls`;
const evidence = { project, image, source, checks: [], cleanup: false };
mkdirSync(tlsDir, { recursive: true });
const evidencePath = `${runDir}/evidence.json`;
const logsPath = `${runDir}/commands.log`;
let commandLog = '';
function run(program, args, expected = 0) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 20000000, timeout: 180000 });
  commandLog += `\n$ ${program} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(logsPath, commandLog);
  if (result.error) throw result.error;
  if (expected !== null) assert.equal(result.status, expected, `${program} exit ${result.status}; inspect ${logsPath}`);
  return result;
}
function passed(name, details = {}) {
  evidence.checks.push({ name, ...details });
  console.log(`PASS ${name}`);
}
const composeArgs = ['compose', '-p', project, '-f', `${runDir}/compose.json`];
const compose = args => run('docker', [...composeArgs, ...args]);
const runtime = (command, trusted = true, extra = []) => run('docker', [...composeArgs, 'run', '--rm', '--no-deps', ...(trusted ? [] : ['-e', 'NODE_EXTRA_CA_CERTS=']), ...extra, 'runtime', 'node', 'dist/runtime.js', command], null);
async function http(port, route, method = 'GET') {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tlsDir}/ca.key`, '-out', `${tlsDir}/ca.crt`, '-days', '1', '-subj', '/CN=Gospel isolated verification CA']);
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tlsDir}/server.key`, '-out', `${tlsDir}/server.csr`, '-subj', '/CN=db']);
  writeFileSync(`${tlsDir}/extensions.cnf`, 'subjectAltName=DNS:db\nextendedKeyUsage=serverAuth\n');
  run('openssl', ['x509', '-req', '-in', `${tlsDir}/server.csr`, '-CA', `${tlsDir}/ca.crt`, '-CAkey', `${tlsDir}/ca.key`, '-CAcreateserial', '-out', `${tlsDir}/server.crt`, '-days', '1', '-extfile', `${tlsDir}/extensions.cnf`]);
  writeFileSync(`${runDir}/compose.json`, JSON.stringify({
    services: {
      db: {
        image: 'postgres:17-alpine',
        environment: { POSTGRES_USER: 'verification', POSTGRES_PASSWORD: 'isolated-local-only', POSTGRES_DB: 'verification' },
        volumes: [`${tlsDir}:/tls:ro`],
        entrypoint: ['sh', '-c', 'cp /tls/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tls/server.crt -c ssl_key_file=/tmp/server.key'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U verification -d verification'], interval: '1s', timeout: '3s', retries: 30 },
        networks: ['isolated'],
      },
      runtime: {
        image,
        environment: { APP_ENV: 'staging', DATABASE_URL: 'postgres://verification:isolated-local-only@db:5432/verification', NODE_EXTRA_CA_CERTS: '/tls/ca.crt', SENDING_ENABLED: 'false', PORT: '9127' },
        volumes: [`${tlsDir}/ca.crt:/tls/ca.crt:ro`],
        networks: ['isolated'],
      },
      ingress: {
        image,
        command: ['node', '-e', "require('http').createServer((req,res)=>{const p=require('http').request({host:'runtime',port:9127,path:req.url,method:req.method},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res)});p.on('error',()=>{res.writeHead(502);res.end()});req.pipe(p)}).listen(9127,'0.0.0.0')"],
        ports: ['127.0.0.1::9127'],
        networks: ['isolated', 'ingress'],
      },
    },
    networks: { isolated: { internal: true }, ingress: {} },
  }, null, 2));
  run('docker', ['build', '-f', `${source}/local-lab/Dockerfile.runtime`, '-t', image, source]);
  const inspect = JSON.parse(run('docker', ['image', 'inspect', image]).stdout)[0];
  assert.equal(inspect.Config.User, 'node');
  const contents = run('docker', ['run', '--rm', '--network', 'none', image, 'node', '--input-type=module', '-e', "import fs from 'node:fs'; console.log(JSON.stringify({uid:process.getuid(),files:fs.readdirSync('/app/dist')}))"]).stdout;
  const artifact = JSON.parse(contents.trim());
  assert.notEqual(artifact.uid, 0);
  for (const file of artifact.files) assert(!/^(app|core|http|fake)\.js$|\.test\.js$/.test(file), `unexpected runtime entrypoint ${file}`);
  assert(artifact.files.includes('runtime.js'));
  passed('image nonroot and production entrypoints only', artifact);
  compose(['up', '-d', '--wait', 'db']);
  const noTrust = runtime('migrate', false);
  assert.equal(noTrust.status, 1);
  assert.match(noTrust.stdout, /"event":"runtime_failed"/);
  passed('untrusted PostgreSQL TLS fails closed', { exit: noTrust.status, output: noTrust.stdout.trim() });
  compose(['up', '-d', 'runtime', 'ingress']);
  const published = compose(['port', 'ingress', '9127']).stdout.trim();
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const port = Number(published.split(':').at(-1));
  let before;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { before = await http(port, '/health'); break; } catch { await wait(500); }
  }
  assert.equal(before?.status, 503);
  passed('service before migration reports unhealthy at nondefault PORT', { containerPort: 9127, published, response: before });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const migration = runtime('migrate');
    assert.equal(migration.status, 0);
    assert.match(migration.stdout, /"event":"migration_complete"/);
    passed(`migration ${attempt} succeeds`, { exit: migration.status, output: migration.stdout.trim() });
  }
  const after = await http(port, '/health');
  assert.equal(after.status, 200);
  assert.equal(after.body.ok, true);
  passed('service health recovers after migrations', after);
  const status = await http(port, '/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.deliveries, []);
  passed('GET status succeeds', status);
  const post = await http(port, '/send', 'POST');
  assert.equal(post.status, 405);
  passed('POST send route refuses mutation', post);
  const tlsCount = compose(['exec', '-T', 'db', 'psql', '-U', 'verification', '-d', 'verification', '-Atc', 'SELECT count(*) FROM pg_stat_ssl WHERE ssl AND pid <> pg_backend_pid()']).stdout.trim();
  assert(Number(tlsCount) >= 1);
  passed('PostgreSQL observes runtime TLS connection', { activeTlsConnections: Number(tlsCount) });
  const held = runtime('send');
  assert.equal(held.status, 0);
  assert.match(held.stdout, /"event":"sending_held"/);
  const runtimeEnv = inspect.Config.Env || [];
  assert(!runtimeEnv.some(value => /^GREEN_API_|^TARGET_CHAT_ID=/.test(value)));
  passed('disabled send held with zero provider config', { exit: held.status, output: held.stdout.trim() });
  const emptyDir = `${runDir}/empty-content`;
  const approvedDir = `${runDir}/synthetic-content`;
  mkdirSync(emptyDir);
  mkdirSync(`${approvedDir}/messages`, { recursive: true });
  writeFileSync(`${emptyDir}/schedule.json`, JSON.stringify({ schemaVersion: 1, messages: [] }));
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const dateAfter = days => new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
  const messages = Array.from({ length: 14 }, (_, day) => {
    const date = dateAfter(day);
    const payload = `Synthetic isolated verification content for ${date}.\n`;
    const file = `messages/${date}.txt`;
    writeFileSync(`${approvedDir}/${file}`, payload);
    return { date, file, sha256: createHash('sha256').update(payload).digest('hex') };
  });
  writeFileSync(`${approvedDir}/schedule.json`, JSON.stringify({ schemaVersion: 1, messages }));
  const contentMount = directory => ['-e', 'CONTENT_DIR=/verification/content', '-v', `${directory}:/verification/content:ro`];
  const empty = runtime('content-check', true, contentMount(emptyDir));
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /approved_content_horizon_too_short/);
  passed('empty approved content fails CLI with actionable reason', { exit: empty.status, output: empty.stdout.trim() });
  const valid = runtime('content-check', true, contentMount(approvedDir));
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /"event":"content_valid"/);
  assert.match(valid.stdout, /"contentDaysRemaining":14/);
  assert.match(valid.stdout, new RegExp(`"date":"${today}"`));
  passed('fourteen dated synthetic content days pass CLI', { exit: valid.status, output: valid.stdout.trim() });
  const otherTarget = '111111111111@g.us';
  const target = '222222222222@g.us';
  const payload = 'Synthetic isolated confirmed delivery.';
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  compose(['exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'verification', '-d', 'verification', '-c',
    `INSERT INTO deliveries(id,channel,target,date,payload,payload_hash,status,attempts,provider_id,evidence) VALUES ('${randomUUID()}','green-api','${otherTarget}','${today}','${payload}','${payloadHash}','confirmed',1,'isolated-confirmed-id','synthetic image verification')`]);
  const policy = [...contentMount(approvedDir), '-e', `TARGET_CHAT_ID=${target}`, '-e', 'SENDING_ENABLED=true', '-e', 'DELIVERY_DEADLINE_MINUTE=0'];
  const missing = runtime('check', true, [...policy, '-e', `FIRST_SEND_DATE=${today}`]);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"event":"delivery_check"[^\n]*"status":"missing"/);
  assert.match(missing.stdout, /"event":"delivery_problem"/);
  passed('check reports the configured target missing despite another confirmed group', { exit: missing.status, output: missing.stdout.trim() });
  const future = runtime('check', true, [...policy, '-e', `FIRST_SEND_DATE=${dateAfter(1)}`]);
  assert.equal(future.status, 0);
  assert.match(future.stdout, /"event":"delivery_check"[^\n]*"status":"held"/);
  assert.doesNotMatch(future.stdout, /"event":"delivery_problem"/);
  passed('check holds the configured target before its first send date', { exit: future.status, output: future.stdout.trim() });
  const reconciled = runtime('reconcile', true, ['-e', 'CONTENT_DIR=/does-not-exist', '-e', `TARGET_CHAT_ID=${target}`,
    '-e', 'GREEN_API_URL=https://api.green-api.com', '-e', 'GREEN_API_ID=0', '-e', 'GREEN_API_TOKEN=isolated-synthetic-token']);
  assert.equal(reconciled.status, 0);
  assert.match(reconciled.stdout, /"event":"reconciliation_complete","checked":0,"confirmed":0/);
  passed('reconcile with no accepted rows succeeds without content', { exit: reconciled.status, output: reconciled.stdout.trim() });
  evidence.result = 'PASS';
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = String(error.stack || error);
  console.error(evidence.error);
  process.exitCode = 1;
} finally {
  try {
    const logs = run('docker', [...composeArgs, 'logs', '--no-color'], null);
    writeFileSync(`${runDir}/containers.log`, `${logs.stdout || ''}${logs.stderr || ''}`);
  } catch {}
  try {
    compose(['down', '--volumes', '--remove-orphans']);
    run('docker', ['image', 'rm', image]);
    const containers = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim();
    const networks = run('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim();
    assert.equal(containers, '');
    assert.equal(networks, '');
    evidence.cleanup = true;
    console.log('PASS owned Docker containers, network, volumes and image removed');
  } catch (error) {
    evidence.cleanupError = String(error);
    process.exitCode = 1;
  }
  rmSync(`${tlsDir}/ca.key`, { force: true });
  rmSync(`${tlsDir}/server.key`, { force: true });
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`${evidence.result || 'FAIL'} ${evidencePath}`);
}
