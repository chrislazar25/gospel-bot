import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectCdp } from './whiteboard-cdp.mjs';
class Socket extends EventTarget {
  readyState = 1;
  send(message) { this.last = JSON.parse(message); }
  reply(id, result) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) })); }
}
test('unresponsive commands and opening connections time out', async () => {
  const ws = new Socket();
  const call = connectCdp(ws, 20);
  await call.ready;
  await assert.rejects(call('Page.enable'), /timed out/);
  ws.reply(ws.last.id, {}); // A late reply must be harmless.
  ws.readyState = 0;
  await assert.rejects(connectCdp(ws, 20).ready, /timed out/);
});
for (const event of ['close', 'error']) {
  test(`${event} rejects every pending command and future calls`, async () => {
    const ws = new Socket();
    const call = connectCdp(ws, 1000);
    await call.ready;
    const first = assert.rejects(call('Page.enable'), /connection/);
    const second = assert.rejects(call('Runtime.enable'), /connection/);
    ws.dispatchEvent(new Event(event));
    await Promise.all([first, second]);
    await assert.rejects(call('Page.navigate'), /connection/);
  });
}
test('successful responses resolve their matching commands', async () => {
  const ws = new Socket();
  const call = connectCdp(ws, 1000);
  await call.ready;
  const result = call('Page.enable');
  ws.reply(ws.last.id, { enabled: true });
  assert.deepEqual(await result, { enabled: true });
});
