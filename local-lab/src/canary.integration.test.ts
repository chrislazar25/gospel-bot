import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { CANARY_CONFIRMATION, CANARY_DATE, CANARY_HASH, CANARY_PAYLOAD, canaryConfigSchema, runCanary } from './canary.js';

test('canary uses the real ledger and status role with the actual Green API wire protocol', async t => {
  const admin = createPool(z.literal('postgres://runtime:runtime@db:5432/runtime').parse(process.env.TEST_DATABASE_URL));
  await admin.query('CREATE DATABASE canary');
  await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gospel_runtime') THEN CREATE ROLE gospel_runtime LOGIN PASSWORD 'local-test-only'; END IF; END $$");
  await admin.query("CREATE ROLE gospel_status LOGIN PASSWORD 'local-test-only'");
  const owner = createPool('postgres://runtime:runtime@db:5432/canary');
  await owner.query('GRANT USAGE ON SCHEMA public TO gospel_runtime,gospel_status');
  await migrate(owner);
  const config = canaryConfigSchema.parse({
    APP_ENV: 'staging', CANARY_CONFIRMATION, CANARY_TARGET_CHAT_ID: '15555550123@c.us',
    RELEASE_SHA: 'a'.repeat(40), CANARY_EXPECTED_REVISION: 'a'.repeat(40),
    DATABASE_URL: 'postgres://gospel_runtime:local-test-only@db:5432/canary', STATUS_DATABASE_URL: 'postgres://gospel_status:local-test-only@db:5432/canary',
    GREEN_API_URL: 'https://7107.api.greenapi.com', GREEN_API_ID: '1234', GREEN_API_TOKEN: 'test-token',
  });
  let mode = 'delivered';
  let sends = 0;
  let receipts = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const reply = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url === '/waInstance1234/getStateInstance/test-token') return reply({ stateInstance: 'authorized' });
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (req.url === '/waInstance1234/sendMessage/test-token') {
        z.object({ chatId: z.literal(config.CANARY_TARGET_CHAT_ID), message: z.literal(CANARY_PAYLOAD) }).strict().parse(body);
        sends++;
        if (mode === 'drop') { res.destroy(); return; }
        return reply({ idMessage: 'CANARY-PRIVATE-ONE' });
      }
      if (req.url === '/waInstance1234/getMessage/test-token') {
        z.object({ chatId: z.literal(config.CANARY_TARGET_CHAT_ID), idMessage: z.literal('CANARY-PRIVATE-ONE') }).strict().parse(body);
        receipts++;
        return reply({ type: 'outgoing', chatId: mode === 'wrong-chat' ? '15555550124@c.us' : config.CANARY_TARGET_CHAT_ID, idMessage: mode === 'wrong-id' ? 'OTHER' : 'CANARY-PRIVATE-ONE', statusMessage: mode === 'wrong-id' || mode === 'wrong-chat' ? 'delivered' : mode });
      }
      res.writeHead(404).end('{}');
    })().catch(() => res.writeHead(400).end('{}'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const request: typeof fetch = (input, init) => {
    if (mode === 'before-http') throw new Error('injected crash before provider HTTP');
    const upstream = new URL(String(input));
    assert.equal(upstream.origin, config.GREEN_API_URL);
    return fetch(`http://127.0.0.1:${address.port}${upstream.pathname}`, init);
  };
  const pools: string[] = [];
  const execute = () => runCanary(config, { request, pool: url => { pools.push(new URL(url).username); return createPool(url); }, receiptChecks: 2, pause: async () => {} });
  async function reset() { await owner.query('TRUNCATE deliveries,delivery_evidence'); mode = 'delivered'; sends = 0; receipts = 0; pools.length = 0; }
  async function seed(status: string, payload = CANARY_PAYLOAD, hash = CANARY_HASH) {
    await owner.query("INSERT INTO deliveries(id,channel,target,date,payload,payload_hash,status,attempts,provider_id) VALUES($1,'green-api',$2,$3,$4,$5,$6,$7,$8)", [randomUUID(), config.CANARY_TARGET_CHAT_ID, CANARY_DATE, payload, hash, status, status === 'pending' ? 0 : 1, ['accepted', 'confirmed', 'failed'].includes(status) ? 'CANARY-PRIVATE-ONE' : null]);
  }
  try {
    await t.test('concurrent invocations send once, confirm by receipt and prove loopback HTTP using only runtime and status roles', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 8 }, execute));
      const result = await execute();
      assert.equal(result.event, 'canary_verified');
      assert.equal(result.priorConfirmation, true);
      assert.equal(result.statusHttp, 'loopback-verified');
      assert.equal(new Set(results.map(value => value.deliveryId)).size, 1);
      assert.equal(sends, 1);
      assert.equal((await owner.query('SELECT date,attempts FROM deliveries')).rows[0]?.date, CANARY_DATE);
      assert.deepEqual(new Set(pools), new Set(['gospel_runtime', 'gospel_status']));
      const readonly = createPool(config.STATUS_DATABASE_URL);
      try { await assert.rejects(readonly.query('DELETE FROM deliveries'), /permission denied/); } finally { await readonly.end(); }
      assert.ok(!JSON.stringify(result).includes(config.CANARY_TARGET_CHAT_ID));
      assert.ok(!JSON.stringify(result).includes(config.GREEN_API_TOKEN));
    });
    await t.test('a later real date and revision reuse the permanent ledger identity', async () => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T00:00:00Z') });
      try {
        const result = await runCanary({ ...config, RELEASE_SHA: 'b'.repeat(40), CANARY_EXPECTED_REVISION: 'b'.repeat(40) }, { request, pool: url => createPool(url), receiptChecks: 1 });
        assert.equal(result.priorConfirmation, true); assert.equal(sends, 1);
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM deliveries')).rows[0]?.count, 1);
      } finally { t.mock.timers.reset(); }
    });
    for (const status of ['unknown', 'failed', 'confirmed']) await t.test(`existing ${status} is retained without any provider submission`, async () => {
      await reset(); await seed(status);
      const result = await execute();
      assert.equal(result.status, status); assert.equal(sends, 0); assert.equal(receipts, 0);
      assert.equal(result.event, status === 'confirmed' ? 'canary_verified' : 'canary_requires_attention');
    });
    await t.test('a crash after committed claim but before HTTP consumes the attempt', async () => {
      await reset(); mode = 'before-http';
      assert.equal((await execute()).status, 'unknown');
      mode = 'delivered'; await execute(); assert.equal(sends, 0);
      assert.equal((await owner.query('SELECT attempts FROM deliveries')).rows[0]?.attempts, 1);
    });
    await t.test('a lost HTTP response remains unknown across reruns', async () => {
      await reset(); mode = 'drop';
      assert.equal((await execute()).status, 'unknown');
      assert.equal((await execute()).status, 'unknown'); assert.equal(sends, 1); assert.equal(receipts, 0);
    });
    for (const mismatch of ['payload', 'hash']) await t.test(`existing ${mismatch} mismatch fails before claim or HTTP`, async () => {
      await reset(); await seed('pending', mismatch === 'payload' ? 'Other text' : CANARY_PAYLOAD, mismatch === 'hash' ? '0'.repeat(64) : CANARY_HASH);
      await assert.rejects(execute(), /canary_payload_mismatch/); assert.equal(sends, 0);
      assert.equal((await owner.query('SELECT attempts FROM deliveries')).rows[0]?.attempts, 0);
    });
    await t.test('an insert race with mismatched content is held before provider HTTP', async () => {
      await reset();
      await owner.query("CREATE FUNCTION inject_canary_payload() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.payload := 'Unexpected competing content'; NEW.payload_hash := repeat('0',64); RETURN NEW; END $$");
      await owner.query('CREATE TRIGGER inject_canary_payload BEFORE INSERT ON deliveries FOR EACH ROW EXECUTE FUNCTION inject_canary_payload()');
      try { await assert.rejects(execute(), /canary_payload_mismatch/); assert.equal(sends, 0); }
      finally { await owner.query('DROP TRIGGER inject_canary_payload ON deliveries'); await owner.query('DROP FUNCTION inject_canary_payload()'); }
      assert.equal((await owner.query('SELECT status FROM deliveries')).rows[0]?.status, 'unknown');
      await assert.rejects(execute(), /canary_payload_mismatch/); assert.equal(sends, 0);
    });
    await t.test('a crash after HTTP before acceptance bookkeeping retains the consumed claim', async () => {
      await reset();
      await owner.query("CREATE FUNCTION reject_canary_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='accepted' THEN RAISE EXCEPTION 'injected acceptance crash'; END IF; RETURN NEW; END $$");
      await owner.query('CREATE TRIGGER reject_canary_acceptance BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION reject_canary_acceptance()');
      try { assert.equal((await execute()).status, 'unknown'); assert.equal(sends, 1); }
      finally { await owner.query('DROP TRIGGER reject_canary_acceptance ON deliveries'); await owner.query('DROP FUNCTION reject_canary_acceptance()'); }
      assert.equal((await execute()).status, 'unknown'); assert.equal(sends, 1);
    });
    for (const receipt of ['sent', 'wrong-chat', 'wrong-id']) await t.test(`${receipt} receipt remains unconfirmed and accepted reruns only reconcile`, async () => {
      await reset(); mode = receipt;
      assert.equal((await execute()).event, 'canary_requires_attention');
      assert.equal((await execute()).status, 'accepted'); assert.equal(sends, 1); assert.equal(receipts, 4);
      mode = 'read'; assert.equal((await execute()).status, 'confirmed'); assert.equal(sends, 1);
    });
    await t.test('provider receipt failure stays terminal without retry', async () => {
      await reset(); mode = 'failed';
      assert.equal((await execute()).status, 'failed'); await execute(); assert.equal(sends, 1);
    });
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await owner.end();
    await admin.query('DROP DATABASE canary WITH (FORCE)');
    await admin.query('DROP ROLE gospel_status');
    await admin.end();
  }
});
