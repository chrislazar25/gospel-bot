import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { reconcileRole } from './neon-role.mjs';

const require = createRequire('/app/package.json');
const { Client } = require('pg');
const directory = await mkdtemp(join(tmpdir(), 'gospel-cloud-smoke-'));
const database = join(directory, 'postgres');
const certificate = join(directory, 'server.crt');
const key = join(directory, 'server.key');
const now = new Date().toISOString();
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const runId = randomUUID();
const target = '000000000000@g.us';
const payload = `Synthetic Gospel cloud smoke ${runId}.\nExact message text: peace, hope, and joy. ✨\n`;
const payloadHash = createHash('sha256').update(payload).digest('hex');
const password = randomBytes(32).toString('hex');
const credentials = { owner: 'verification', runtime: 'gospel_runtime', status: 'gospel_status' };
const submissions = [];
const checks = [];
const children = new Set();
const interruption = new AbortController();
let receiptMode = 'sent';
let postgresStartAttempted = false;
let client;
let fixture;
let statusServer;
let statusPool;
let proof;
let failure;

function passed(name) {
  checks.push(name);
  process.stdout.write(JSON.stringify({ severity: 'INFO', event: 'cloud_smoke_check', name, runId }) + '\n');
}
function command(program, args, env = { PATH: process.env.PATH }, cleanup = false) {
  return new Promise((resolve, reject) => {
    if (!cleanup && interruption.signal.aborted) return reject(interruption.signal.reason);
    const child = spawn(program, args, { env, stdio: ['ignore', 'pipe', 'pipe'], signal: cleanup ? undefined : interruption.signal });
    children.add(child);
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
async function checked(program, args, cleanup = false) {
  const result = await command(program, args, { PATH: process.env.PATH }, cleanup);
  assert.equal(result.code, 0, `${program} failed: ${result.stderr}`);
  return result;
}
const connection = role => `postgres://${credentials[role]}:${password}@127.0.0.1:5432/verification`;
function runtimeEnv(role, port) {
  return {
    PATH: process.env.PATH, APP_ENV: 'staging', RELEASE_SHA: process.env.RELEASE_SHA,
    DATABASE_URL: connection(role), NODE_EXTRA_CA_CERTS: certificate,
    CONTENT_DIR: join(directory, 'content'), SENDING_ENABLED: 'true', FIRST_SEND_DATE: date,
    SEND_WINDOW_START_MINUTE: '0', SEND_WINDOW_END_MINUTE: '1440', DELIVERY_DEADLINE_MINUTE: '0',
    GREEN_API_URL: 'https://smoke.api.green-api.com', GREEN_API_ID: '0',
    GREEN_API_TOKEN: 'cloud_smoke_synthetic_only', TARGET_CHAT_ID: target,
    SMOKE_NOW: now, SMOKE_PROVIDER_PORT: String(port),
  };
}
async function runtime(operation, env, expected = 0) {
  const result = await command(process.execPath, ['--import', '/verification/transport.mjs', '/app/dist/runtime.js', operation], env);
  if (expected !== null) assert.equal(result.code, expected, `${operation}: ${result.stdout}\n${result.stderr}`);
  return result;
}
async function ledger(expected) {
  const result = await client.query('SELECT * FROM deliveries');
  assert.equal(result.rowCount, 1);
  const row = result.rows[0];
  assert.equal(row.target, target);
  assert.equal(row.date, date);
  assert.equal(row.payload, payload);
  assert.equal(row.payload_hash, payloadHash);
  assert.equal(row.attempts, 1);
  assert.equal(row.status, expected);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0], { chatId: target, message: payload });
  return row;
}
async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}
function interrupt() {
  failure = new Error('smoke_interrupted');
  interruption.abort(failure);
  process.exitCode = 1;
}
process.once('SIGTERM', interrupt);
process.once('SIGINT', interrupt);

try {
  assert.match(process.env.RELEASE_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.notEqual(process.getuid(), 0);
  for (const name of ['DATABASE_URL', 'GREEN_API_URL', 'GREEN_API_ID', 'GREEN_API_TOKEN', 'TARGET_CHAT_ID', 'CONTENT_DIR', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']) {
    assert.equal(process.env[name], undefined, `Smoke must not inherit ${name}`);
  }
  await writeFile(join(directory, 'password'), password, { mode: 0o600 });
  await checked('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
  await checked('chmod', ['600', key]);
  await checked('initdb', ['-D', database, '-U', credentials.owner, '--pwfile=' + join(directory, 'password'), '--auth-host=scram-sha-256', '--auth-local=trust', '--no-locale', '--encoding=UTF8']);
  postgresStartAttempted = true;
  await checked('pg_ctl', ['-D', database, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -k ${directory} -c ssl=on -c ssl_cert_file=${certificate} -c ssl_key_file=${key}`, '-w', 'start']);
  const ssl = { ca: await readFile(certificate), rejectUnauthorized: true };
  const bootstrapUrl = new URL(connection('owner'));
  bootstrapUrl.pathname = '/postgres';
  client = new Client({ connectionString: bootstrapUrl.href, ssl });
  await client.connect();
  await client.query('CREATE DATABASE verification');
  await client.end();
  client = new Client({ connectionString: connection('owner'), ssl });
  await client.connect();
  fixture = createServer((request, response) => {
    void (async () => {
      const path = request.url;
      const reply = body => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (path === '/waInstance0/getStateInstance/cloud_smoke_synthetic_only' && request.method === 'GET') return reply({ stateInstance: 'authorized' });
      let body = '';
      for await (const chunk of request) { body += chunk; assert(body.length < 50000); }
      const input = JSON.parse(body);
      if (path === '/waInstance0/sendMessage/cloud_smoke_synthetic_only' && request.method === 'POST') {
        assert.deepEqual(input, { chatId: target, message: payload });
        submissions.push(input);
        return reply({ idMessage: 'cloud-smoke-provider-id' });
      }
      assert.equal(path, '/waInstance0/getMessage/cloud_smoke_synthetic_only');
      assert.equal(request.method, 'POST');
      assert.deepEqual(input, { chatId: target, idMessage: 'cloud-smoke-provider-id' });
      return reply({ type: 'outgoing', idMessage: receiptMode === 'wrong-id' ? 'unrelated-provider-id' : input.idMessage,
        chatId: receiptMode === 'wrong-chat' ? '111111111111@g.us' : target,
        statusMessage: receiptMode === 'sent' ? 'sent' : 'delivered' });
    })().catch(error => { failure = error; response.writeHead(500).end(); });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const port = fixture.address().port;
  const ownerEnv = runtimeEnv('owner', port);
  const runtimeConfiguration = runtimeEnv('runtime', port);
  const statusEnv = runtimeEnv('status', port);
  await mkdir(join(directory, 'content/messages'), { recursive: true });
  const messages = [];
  for (let day = 0; day < 14; day++) {
    const next = new Date(Date.parse(date) + day * 86400000).toISOString().slice(0, 10);
    const text = day === 0 ? payload : `Synthetic future cloud smoke message for ${next}.\n`;
    const file = `messages/${next}.txt`;
    await writeFile(join(directory, 'content', file), text);
    messages.push({ date: next, file, sha256: createHash('sha256').update(text).digest('hex') });
  }
  await writeFile(join(directory, 'content/schedule.json'), JSON.stringify({ schemaVersion: 1, messages }));
  for (const role of ['runtime', 'status']) await reconcileRole(client, {
    role: credentials[role], password, database: 'verification', owner: credentials.owner, readOnly: role === 'status',
  });
  const untrusted = await runtime('migrate', { ...ownerEnv, NODE_EXTRA_CA_CERTS: '' }, 1);
  assert.match(untrusted.stdout, /"event":"runtime_failed"/);
  passed('runtime refuses the untrusted PostgreSQL certificate');
  await runtime('migrate', ownerEnv);
  await runtime('migrate', ownerEnv);
  passed('real migrations are repeatable over verified PostgreSQL TLS');
  const content = await runtime('content-check', ownerEnv);
  assert.match(content.stdout, /"contentDaysRemaining":14/);
  passed('fourteen synthetic content dates pass the actual CLI');
  const blocked = await command(process.execPath, ['--import', '/verification/transport.mjs', '--input-type=module', '-e', "await fetch('https://example.com')"], ownerEnv);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /smoke_destination_blocked/);
  passed('test transport rejects destinations outside the loopback fixture');
  const held = await runtime('send', { ...runtimeConfiguration, SENDING_ENABLED: 'false' });
  assert.match(held.stdout, /"event":"sending_held"/);
  assert.equal(submissions.length, 0);
  passed('disabled send makes no provider submission');
  const racers = await Promise.all(Array.from({ length: 6 }, () => runtime('send', runtimeConfiguration, null)));
  assert(racers.some(result => result.code === 0 && /"status":"accepted"/.test(result.stdout)));
  for (const result of racers) {
    if (result.code === 0) continue;
    assert.equal(result.code, 1);
    assert.match(result.stdout, /"event":"delivery_attempt"[^\n]*"status":"unknown"/);
    assert.match(result.stdout, /"event":"delivery_problem"/);
  }
  await runtime('send', runtimeConfiguration);
  const accepted = await ledger('accepted');
  passed('concurrent and repeated CLI sends submit the exact message once');
  for (const mode of ['wrong-id', 'wrong-chat', 'sent']) {
    receiptMode = mode;
    await runtime('reconcile', runtimeConfiguration);
    await ledger('accepted');
    passed(`${mode} receipt leaves the message unconfirmed`);
  }
  receiptMode = 'delivered';
  await runtime('reconcile', runtimeConfiguration);
  const confirmed = await ledger('confirmed');
  assert.equal(confirmed.id, accepted.id);
  const evidence = await client.query('SELECT fact FROM delivery_evidence WHERE delivery_id=$1 ORDER BY recorded_at', [confirmed.id]);
  for (const fact of [`created:${process.env.RELEASE_SHA}`, 'attempt committed before HTTP', 'provider accepted; delivery unconfirmed', 'receipt:delivered']) {
    assert(evidence.rows.some(row => row.fact === fact), `Missing audit fact: ${fact}`);
  }
  passed('correlated delivered receipt confirms the original attempt and preserves evidence');
  const check = await runtime('check', statusEnv);
  assert.match(check.stdout, /"event":"delivery_check"[^\n]*"status":"confirmed"/);
  passed('read-only status role reports the confirmed delivery');
  const { createStatusServer } = await import('/app/dist/status.js');
  const { Pool } = require('pg');
  statusPool = new Pool({ connectionString: connection('status'), ssl });
  statusServer = createStatusServer(statusPool, process.env.RELEASE_SHA);
  statusServer.listen(0, '127.0.0.1');
  await once(statusServer, 'listening');
  const statusOrigin = `http://127.0.0.1:${statusServer.address().port}`;
  for (const path of ['/health', `/get-status/${confirmed.id}`]) {
    const response = await fetch(statusOrigin + path, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const body = await response.json();
    if (path === '/health') assert.equal(body.ok, true);
    else assert.equal(body.status, 'confirmed');
  }
  passed('actual HTTP health and delivery-status routes read the database');
  await runtime('send', runtimeConfiguration);
  await runtime('reconcile', runtimeConfiguration);
  await ledger('confirmed');
  passed('confirmed delivery remains single after further CLI executions');
  if (failure) throw failure;
  interruption.signal.throwIfAborted();
  proof = {
    schemaVersion: 1, revision: process.env.RELEASE_SHA, runId, date,
    execution: process.env.CLOUD_RUN_EXECUTION ?? null,
    provider: 'loopback-simulator', database: 'ephemeral-postgres-tls',
    target, payload, payloadHash, deliveryId: confirmed.id, providerId: confirmed.provider_id,
    submissions: submissions.length, attempts: confirmed.attempts, status: confirmed.status, checks,
  };
} catch (error) {
  failure = error;
} finally {
  await Promise.all([...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
    child.once('close', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGTERM');
  })));
  for (const cleanup of [
    () => closeServer(statusServer),
    () => statusPool?.end(),
    () => closeServer(fixture),
    () => client?.end(),
    () => postgresStartAttempted ? checked('pg_ctl', ['-D', database, '-m', 'immediate', '-w', 'stop'], true) : undefined,
    () => rm(directory, { recursive: true, force: true }),
  ]) {
    try { await cleanup(); } catch (error) { failure ??= error; }
  }
}
if (failure) {
  process.stderr.write(JSON.stringify({ severity: 'ERROR', event: 'cloud_smoke_failed', runId, message: failure.message }) + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ severity: 'INFO', event: 'cloud_smoke_verified', ...proof, cleanup: true }) + '\n');
}
