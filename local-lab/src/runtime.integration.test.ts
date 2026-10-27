import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPool } from './db.js';
import { migrate, checkSchema } from './migrate.js';
import { createDeliveryService, type Delivery } from './delivery.js';
import { createGreenApi } from './green-api.js';
import { createStatusServer } from './status.js';

test('real Postgres, production schema, and Green API wire protocol', async t => {
  const url = z.literal('postgres://runtime:runtime@db:5432/runtime').parse(process.env.TEST_DATABASE_URL);
  const db = createPool(url);
  const appDb = createPool('postgres://gospel_runtime:local-test-only@db:5432/runtime');
  let mode = 'success';
  let receipt = 'sent';
  let sends = 0;
  let receiptCalls = 0;
  let expectedId = 'BAE5F4886F6F2D05';
  const chatId = '120363000000000000@g.us';
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const reply = (value: unknown, code = 200) => response.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.url === '/waInstance1234/getStateInstance/test-token') return reply({ stateInstance: mode === 'unauthorized' ? 'notAuthorized' : 'authorized' });
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/waInstance1234/sendMessage/test-token') {
        const parsed = z.object({ chatId: z.literal(chatId), message: z.string().min(1) }).strict().parse(body);
        requests.push(parsed); sends++;
        if (mode === 'drop') { response.destroy(); return; }
        if (mode === 'malformed') return reply({ wrongId: 'not-correlated' });
        if (mode === 'server-error') return reply({ error: 'no proof of rejection' }, 500);
        return reply({ idMessage: expectedId });
      }
      if (request.url === '/waInstance1234/getMessage/test-token') {
        receiptCalls++;
        z.object({ chatId: z.literal(chatId), idMessage: z.literal(expectedId) }).strict().parse(body);
        return reply({ type: 'outgoing', chatId: mode === 'wrong-chat' ? '111@g.us' : chatId, idMessage: mode === 'wrong-id' ? 'BAE5DIFFERENT0000' : expectedId, statusMessage: receipt });
      }
      return reply({ error: 'unexpected method' }, 404);
    })().catch(() => response.writeHead(400).end('{}'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const localFetch: typeof fetch = (input, init) => {
    assert.equal(typeof input, 'string');
    return fetch(new URL(new URL(String(input)).pathname, localOrigin), init);
  };
  const provider = createGreenApi({ url: 'https://api.green-api.com', instanceId: '1234', token: 'test-token' }, localFetch);
  const policy = { kind: 'scheduled', enabled: true, firstDate: '2026-10-27', startMinute: 0, endMinute: 120 } satisfies Parameters<typeof createDeliveryService>[0]['policy'];
  const service = (enabled = true, message = async () => 'Synthetic local Green protocol fixture.\n') => createDeliveryService({ db: appDb, channel: 'green-api', target: chatId, provider, policy: { ...policy, enabled }, now: async () => new Date('2026-10-26T19:00:00Z'), message, revision: 'a'.repeat(40) });
  async function reset() { await db.query('TRUNCATE deliveries,delivery_evidence'); sends = 0; receiptCalls = 0; mode = 'success'; receipt = 'sent'; expectedId = 'BAE5F4886F6F2D05'; }
  try {
    await t.test('status can start before initial migration but reports not ready', async () => {
      const status = createStatusServer(db, 'unreleased');
      try {
        status.listen(0, '127.0.0.1'); await once(status, 'listening');
        const address = status.address(); assert.ok(address && typeof address !== 'string');
        assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 503);
      } finally { status.closeAllConnections(); await new Promise<void>(resolve => status.close(() => resolve())); }
    });
    await t.test('migrations are idempotent and detect changed history', async () => {
      await db.query('CREATE ROLE gospel_runtime LOGIN PASSWORD \'local-test-only\'');
      await db.query('GRANT USAGE ON SCHEMA public TO gospel_runtime');
      await Promise.all([migrate(db), migrate(db)]);
      await checkSchema(db);
      await db.query("UPDATE schema_migrations SET checksum='tampered'");
      await assert.rejects(migrate(db), /checksum_changed/);
      await db.query('DELETE FROM schema_migrations');
      await db.query('DROP TABLE delivery_evidence,deliveries');
      await db.query('DROP FUNCTION preserve_delivery(),record_delivery_evidence()');
      await migrate(db);
    });
    await t.test('runtime role cannot erase deliveries, edit frozen content, or change audit evidence', async () => {
      await assert.rejects(appDb.query('DELETE FROM deliveries'), /permission denied/);
      await assert.rejects(appDb.query("UPDATE deliveries SET payload='changed'"), /permission denied/);
      await assert.rejects(appDb.query('DELETE FROM delivery_evidence'), /permission denied/);
      await assert.rejects(appDb.query("UPDATE delivery_evidence SET fact='changed'"), /permission denied/);
      await assert.rejects(appDb.query('DELETE FROM schema_migrations'), /permission denied/);
    });
    await t.test('sending hold and missing approved content cause zero provider submissions', async () => {
      await reset();
      await assert.rejects(service(false).sendToday(), /sending_held/);
      await assert.rejects(service(true, async () => { throw new Error('approved_content_missing'); }).sendToday(), /content_missing/);
      assert.equal(sends, 0);
      assert.equal((await db.query('SELECT * FROM deliveries')).rowCount, 0);
    });
    let accepted: Delivery;
    await t.test('competing replicas share one frozen row and one external submission', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 24 }, () => service().sendToday()));
      assert.equal(new Set(results.map(row => row.id)).size, 1);
      assert.equal(sends, 1);
      const id = results[0]?.id; assert.ok(id);
      accepted = await service().get(id);
      assert.equal(accepted.status, 'accepted');
      assert.equal(accepted.provider_id, expectedId);
      assert.equal((await service(true, async () => 'changed content').sendToday()).payload, accepted.payload);
      await assert.rejects(db.query("UPDATE deliveries SET payload='changed'"), /immutable/);
      await assert.rejects(db.query("UPDATE deliveries SET status='pending',provider_id=NULL,attempts=0"), /transition/);
      assert.equal(requests.length, 1);
    });
    await t.test('receipts must match the exact chat and provider ID before confirmation', async () => {
      receipt = 'delivered'; mode = 'wrong-chat';
      assert.equal((await service().reconcile(accepted.id)).status, 'accepted');
      mode = 'wrong-id';
      assert.equal((await service().reconcile(accepted.id)).status, 'accepted');
      mode = 'success'; receipt = 'sent';
      assert.equal((await service().reconcile(accepted.id)).status, 'accepted');
      receipt = 'delivered';
      assert.equal((await service().reconcile(accepted.id)).status, 'confirmed');
      await assert.rejects(db.query("UPDATE deliveries SET status='accepted'"), /transition/);
      await service().sendToday(); assert.equal(sends, 1);
    });
    await t.test('provider failed is terminal and never permits another submission', async () => {
      await reset(); const row = await service().sendToday(); receipt = 'failed';
      assert.equal((await service().reconcile(row.id)).status, 'failed');
      await service().sendToday(); assert.equal(sends, 1);
    });
    for (const failure of ['drop', 'malformed', 'server-error', 'unauthorized']) {
      await t.test(`${failure} stays unknown and is never retried or guessed from journal history`, async () => {
        await reset(); mode = failure;
        const row = await service().sendToday(); assert.equal(row.status, 'unknown');
        await service().sendToday(); await service().reconcile(row.id);
        assert.equal(sends, failure === 'unauthorized' ? 0 : 1);
        assert.equal(receiptCalls, 0);
      });
    }
    await t.test('acceptance bookkeeping failure remains held after the external send', async () => {
      await reset();
      await db.query("CREATE FUNCTION reject_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='accepted' THEN RAISE EXCEPTION 'injected bookkeeping failure'; END IF; RETURN NEW; END $$");
      await db.query('CREATE TRIGGER reject_acceptance BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION reject_acceptance()');
      const row = await service().sendToday();
      assert.equal(row.status, 'unknown'); assert.equal(sends, 1);
      await db.query('DROP TRIGGER reject_acceptance ON deliveries'); await db.query('DROP FUNCTION reject_acceptance()');
      await service().sendToday(); assert.equal(sends, 1);
    });
    await t.test('private status routes work with a read-only database role and never call provider', async () => {
      await db.query('CREATE ROLE status_reader LOGIN PASSWORD \'local-test-only\'');
      await db.query('GRANT USAGE ON SCHEMA public TO status_reader');
      await db.query('GRANT SELECT ON deliveries,schema_migrations TO status_reader');
      const readonly = createPool('postgres://status_reader:local-test-only@db:5432/runtime');
      const status = createStatusServer(readonly, 'a'.repeat(40));
      try {
        status.listen(0, '127.0.0.1'); await once(status, 'listening');
        const address = status.address(); assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        const before = { sends, receiptCalls };
        assert.equal((await fetch(base + '/health')).status, 200);
        assert.equal((await fetch(base + '/status')).status, 200);
        assert.equal((await fetch(base + '/send-todays-message', { method: 'POST' })).status, 405);
        assert.equal((await fetch(base + '/get-status/' + randomUUID())).status, 404);
        assert.deepEqual({ sends, receiptCalls }, before);
        await assert.rejects(readonly.query('DELETE FROM deliveries'), /permission denied/);
      } finally { status.closeAllConnections(); await new Promise<void>(resolve => status.close(() => resolve())); await readonly.end(); }
    });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await appDb.end(); await db.end(); }
});
