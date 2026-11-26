import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridge, type Incoming, type Whatsapp } from './bridge.js';
import type { Github } from './github.js';
import type { Issue } from './states.js';
import { openStore, type Key } from './store.js';

const GROUP = '120363@g.us';
const dad = (id: string, text = 'The reading is wrong today', remoteJid = GROUP): Incoming => ({
  key: { remoteJid, id, participant: '15551230000@s.whatsapp.net', fromMe: false }, text,
});

function setup() {
  const calls: { kind: 'react' | 'reply'; key: Key; value: string }[] = [];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const issues = new Map<number, Issue>();
  const faults = { create: false, get: new Set<number>(), reply: false };
  let botId = 0;
  const wa: Whatsapp = {
    async react(key, emoji) { calls.push({ kind: 'react', key, value: emoji }); },
    async reply(key, text) {
      if (faults.reply) throw new Error('wa_down');
      calls.push({ kind: 'reply', key, value: text });
      return `BOT${++botId}`;
    },
  };
  const github: Github = {
    async create(issue) {
      if (faults.create) throw new Error('github_503');
      created.push(issue);
      const number = 100 + created.length;
      issues.set(number, { number, state: 'open', stateReason: null, labels: issue.labels });
      return number;
    },
    async get(n) {
      if (faults.get.has(n)) throw new Error('github_502');
      return issues.get(n)!;
    },
  };
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'bridge-')), 'home'));
  const logs: { event: string; fields: object | undefined }[] = [];
  const bridge = createBridge({ wa, github, store, groupJid: GROUP, log: (event, fields) => logs.push({ event, fields }) });
  const label = (n: number, ...labels: string[]) => { issues.get(n)!.labels = ['benny:report', ...labels]; };
  return { bridge, calls, created, issues, faults, store, logs, label };
}

test('a new report creates one labelled issue, reacts with eyes and is remembered', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1', 'Call 555 123 4567, the reading is wrong'));
  assert.equal(t.created.length, 1);
  assert.deepEqual(t.created[0]!.labels, ['benny:report', 'benny:new']);
  assert.ok(t.created[0]!.title.startsWith('WhatsApp report: '));
  assert.ok(!t.created[0]!.body.includes('555'));
  assert.ok(t.created[0]!.body.includes('<!-- wa-message:M1 -->'));
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value, c.key.id]), [['react', '👀', 'M1']]);
  assert.deepEqual(t.store.entries().map(([n, e]) => [n, e.applied, e.key.participant]), [[101, 'new', '15551230000@s.whatsapp.net']]);
});

test('a redelivered message does not create a second issue', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  await t.bridge.onMessage(dad('M1'));
  await Promise.all([t.bridge.onMessage(dad('M2')), t.bridge.onMessage(dad('M2'))]);
  assert.equal(t.created.length, 2);
  assert.equal(t.calls.length, 2);
});

test('messages from other chats and empty messages are ignored', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1', 'hello', '999@g.us'));
  await t.bridge.onMessage(dad('M2', '   \n '));
  assert.equal(t.created.length, 0);
  assert.equal(t.calls.length, 0);
});

test("the owner's own manual message is accepted", async () => {
  const t = setup();
  const own: Incoming = { key: { remoteJid: GROUP, id: 'MINE', fromMe: true }, text: 'testing the bridge' };
  await t.bridge.onMessage(own);
  assert.equal(t.created.length, 1);
});

test('messages the bridge sent itself are never turned into reports', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:pr');
  await t.bridge.poll();
  const reply = t.calls.find((c) => c.kind === 'reply')!;
  assert.ok(reply);
  await t.bridge.onMessage({ key: { remoteJid: GROUP, id: 'BOT1', fromMe: true }, text: 'anything' });
  await t.bridge.onMessage({ key: { remoteJid: GROUP, id: 'RACE', fromMe: true }, text: reply.value });
  assert.equal(t.created.length, 1);
});

test('a status change reacts once, replies when the state has a reply, and quotes the original message', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;

  await t.bridge.poll();
  assert.equal(t.calls.length, 0);

  t.label(101, 'benny:triage');
  await t.bridge.poll();
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '🔎']]);

  t.label(101, 'benny:triage', 'benny:no-repro');
  await t.bridge.poll();
  assert.deepEqual(t.calls.slice(1).map((c) => [c.kind, c.value]), [
    ['react', '🤔'],
    ['reply', "🤖 Couldn't make this happen. Can you tell me more about what you saw?"],
  ]);
  assert.ok(t.calls.every((c) => c.key.id === 'M1' && c.key.participant === '15551230000@s.whatsapp.net'));
  assert.equal(t.store.entries()[0]![1].applied, 'no-repro');
});

test('skipped states are not announced, only the current one', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;
  t.label(101, 'benny:bug', 'benny:fixing', 'benny:pr');
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '📬'], ['reply', '🤖 A fix is ready. Chris will review it.']]);
});

test('states without a reply only get a reaction', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;
  for (const [l, emoji] of [['benny:bug', '🐞'], ['benny:fixing', '🛠️']] as const) {
    t.label(101, l);
    await t.bridge.poll();
    assert.deepEqual(t.calls.splice(0).map((c) => [c.kind, c.value]), [['react', emoji]]);
  }
});

test('a merged issue gets a check mark and thanks, then is dropped and no longer polled', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;
  t.issues.set(101, { number: 101, state: 'closed', stateReason: 'completed', labels: ['benny:report', 'benny:pr'] });
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '✅'], ['reply', '🤖 Fixed. Thanks for reporting!']]);
  assert.equal(t.store.entries().length, 0);
  t.faults.get.add(101);
  await t.bridge.poll();
  assert.equal(t.calls.length, 2);
});

test('a GitHub failure on one issue is retried next tick and does not block the others', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  await t.bridge.onMessage(dad('M2'));
  t.calls.length = 0;
  t.label(101, 'benny:triage');
  t.label(102, 'benny:triage');
  t.faults.get.add(101);
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.key.id, c.value]), [['M2', '🔎']]);
  assert.ok(t.logs.some((l) => l.event === 'poll_failed'));
  t.faults.get.clear();
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.key.id, c.value]), [['M2', '🔎'], ['M1', '🔎']]);
});

test('a failed reply leaves the state unapplied so the next tick retries', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:pr');
  t.faults.reply = true;
  await t.bridge.poll();
  assert.equal(t.store.entries()[0]![1].applied, 'new');
  t.faults.reply = false;
  await t.bridge.poll();
  assert.equal(t.store.entries()[0]![1].applied, 'pr');
  assert.equal(t.calls.filter((c) => c.kind === 'reply').length, 1);
});

test('when GitHub is down a report is not remembered, not reacted to, and a retry can still create it', async () => {
  const t = setup();
  t.faults.create = true;
  await t.bridge.onMessage(dad('M1'));
  assert.equal(t.store.entries().length, 0);
  assert.equal(t.calls.length, 0);
  t.faults.create = false;
  await t.bridge.onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
});

test('logs carry ids but never the report text or the sender', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1', 'secret wording here'));
  const dump = JSON.stringify(t.logs);
  assert.ok(dump.includes('report_created'));
  assert.ok(!dump.includes('secret wording') && !dump.includes('15551230000'));
});
