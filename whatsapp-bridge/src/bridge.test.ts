import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBridge, type Attachment, type Incoming, type Whatsapp } from './bridge.js';
import { createGithub, type Github } from './github.js';
import type { Issue } from './states.js';
import { openStore, type Key } from './store.js';

const GROUP = '120363@g.us';
const dad = (id: string, text = 'The reading is wrong today', remoteJid = GROUP, attachment: Attachment | null = null): Incoming => ({
  key: { remoteJid, id, participant: '15551230000@s.whatsapp.net', fromMe: false }, text, quotedId: null, attachment,
});
const quoting = (m: Incoming, quotedId: string): Incoming => ({ ...m, quotedId });
const photo = (id: string, caption = '', bytes = Buffer.from('jpeg-bytes')) =>
  dad(id, caption, GROUP, { kind: 'image', mimetype: 'image/jpeg', download: async () => bytes });
const voiceNote = (id: string) => dad(id, '', GROUP, { kind: 'unsupported' });

function setup() {
  const calls: { kind: 'react' | 'reply'; key: Key; value: string; id?: string }[] = [];
  const replyIds: string[] = [];
  const created: { title: string; body: string; labels: string[] }[] = [];
  const issues = new Map<number, Issue>();
  const uploaded: { path: string; size: number }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const labelled: { issue: number; label: string }[] = [];
  const faults = { create: false, createLost: false, get: new Set<number>(), reply: false, replyLost: false, upload: false, label: false };
  const wa: Whatsapp = {
    async react(key, emoji) { calls.push({ kind: 'react', key, value: emoji }); },
    async reply(key, text, id) {
      if (faults.reply) throw new Error('wa_down');
      calls.push({ kind: 'reply', key, value: text, id });
      replyIds.push(id);
      if (faults.replyLost) throw new Error('wa_timeout');
    },
  };
  const github: Github = {
    async create(issue) {
      if (faults.create) throw new Error('github_503');
      created.push(issue);
      const number = 100 + created.length;
      issues.set(number, { number, state: 'open', stateReason: null, labels: issue.labels });
      if (faults.createLost) throw new Error('timeout');
      return number;
    },
    async findByMarker(marker) {
      const i = created.findIndex((c) => c.body.includes(marker));
      return i < 0 ? undefined : 101 + i;
    },
    async get(n) {
      if (faults.get.has(n)) throw new Error('github_502');
      return issues.get(n)!;
    },
    async comment(issue, body) { comments.push({ issue, body }); },
    async addLabel(issue, label) {
      if (faults.label) throw new Error('github_502');
      labelled.push({ issue, label });
    },
    async upload(path, bytes) {
      if (faults.upload) throw new Error('github_500');
      uploaded.push({ path, size: bytes.length });
      return `https://raw.example/${path}`;
    },
  };
  const home = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'home');
  const store = openStore(home);
  const logs: { event: string; fields: object | undefined }[] = [];
  const log = (event: string, fields?: object) => logs.push({ event, fields });
  const bridge = createBridge({ wa, github, store, groupJid: GROUP, log });
  const restart = (groupJid = GROUP) => createBridge({ wa, github, store: openStore(home), groupJid, log });
  const label = (n: number, ...labels: string[]) => { issues.get(n)!.labels = ['benny:report', ...labels]; };
  return { bridge, restart, home, calls, replyIds, created, uploaded, comments, labelled, issues, faults, store, logs, label };
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

test('after switching to another group, reports from the old group are dropped without messaging it', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;
  t.label(101, 'benny:pr');
  await t.restart('777@g.us').poll();
  assert.deepEqual(t.calls, []);
  assert.deepEqual(openStore(t.home).entries(), []);
  assert.ok(t.logs.some((l) => l.event === 'stale_group'));
});

test('after switching groups, a pending report from the old group is not recovered and never messages it', async () => {
  const t = setup();
  t.faults.createLost = true;
  await t.bridge.onMessage(dad('M1'));
  t.faults.createLost = false;
  const again = t.restart('777@g.us');
  await again.poll();
  await again.poll();
  assert.deepEqual(t.calls, []);
  assert.deepEqual(openStore(t.home).entries(), []);
  assert.equal(openStore(t.home).message('M1')?.status, 'done');
  assert.ok(t.logs.some((l) => l.event === 'stale_group'));
  await t.restart().onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
});

test("the owner's own manual message is accepted", async () => {
  const t = setup();
  const own: Incoming = { key: { remoteJid: GROUP, id: 'MINE', fromMe: true }, text: 'testing the bridge', quotedId: null, attachment: null };
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
  await t.bridge.onMessage({ key: { remoteJid: GROUP, id: reply.id!, fromMe: true }, text: reply.value, quotedId: 'M1', attachment: null });
  assert.equal(t.created.length, 1);
  assert.equal(t.comments.length, 0);
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

test('an issue closed as not planned is acknowledged once, dropped and no longer polled', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.calls.length = 0;
  t.issues.set(101, { number: 101, state: 'closed', stateReason: 'not_planned', labels: ['benny:report', 'benny:triage'] });
  await t.bridge.poll();
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '💬'], ['reply', '🤖 Chris closed this one.']]);
  assert.equal(t.store.entries().length, 0);
  t.faults.get.add(101);
  await t.bridge.poll();
  assert.equal(t.calls.length, 2);
  assert.ok(!t.logs.some((l) => l.event === 'poll_failed'));
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

test('a failed reply is retried next tick with the same message id, and only once it succeeds is the state settled', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:pr');
  t.faults.reply = true;
  await t.bridge.poll();
  assert.equal(t.replyIds.length, 0);
  t.faults.reply = false;
  await t.bridge.poll();
  await t.bridge.poll();
  assert.equal(t.calls.filter((c) => c.kind === 'reply').length, 1);
  assert.deepEqual(t.store.entries()[0]![1].replies, t.replyIds);
});

test('a reply WhatsApp accepted but never confirmed is resent after a restart with the same id', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:no-repro');
  t.faults.replyLost = true;
  await t.bridge.poll();
  t.faults.replyLost = false;
  const again = t.restart();
  await again.poll();
  await again.poll();
  assert.equal(t.replyIds.length, 2);
  assert.equal(t.replyIds[0], t.replyIds[1]);
  assert.match(t.replyIds[0]!, /^3EB0[0-9A-F]{18}$/);
  assert.deepEqual(openStore(t.home).entries()[0]![1].replies, [t.replyIds[0]]);
  assert.equal(openStore(t.home).entries()[0]![1].applied, 'no-repro');
});

test('a terminal reply that was never confirmed is resent with the same id before the report is dropped', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.issues.set(101, { number: 101, state: 'closed', stateReason: 'completed', labels: [] });
  t.faults.replyLost = true;
  await t.bridge.poll();
  assert.equal(t.store.entries().length, 1);
  t.faults.replyLost = false;
  await t.restart().poll();
  assert.equal(t.replyIds.length, 2);
  assert.equal(t.replyIds[0], t.replyIds[1]);
  assert.equal(openStore(t.home).entries().length, 0);
});

test('asking the same question twice on one issue sends two distinct messages', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:no-repro');
  await t.bridge.poll();
  t.label(101, 'benny:triage');
  await t.bridge.poll();
  t.label(101, 'benny:no-repro');
  await t.bridge.poll();
  assert.equal(t.replyIds.length, 2);
  assert.notEqual(t.replyIds[0], t.replyIds[1]);
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

test('a report whose create response was lost adopts the existing issue when the message is redelivered', async () => {
  const t = setup();
  t.faults.createLost = true;
  await t.bridge.onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
  assert.equal(t.calls.length, 0);
  t.faults.createLost = false;
  await t.bridge.onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
  assert.deepEqual(t.store.entries().map(([n, e]) => [n, e.key.id]), [[101, 'M1']]);
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value, c.key.id]), [['react', '👀', 'M1']]);
});

test('after a crash between creating the issue and saving it, the next poll adopts the issue', async () => {
  const t = setup();
  t.faults.createLost = true;
  await t.bridge.onMessage(dad('M1'));
  t.faults.createLost = false;
  const again = t.restart();
  await again.poll();
  assert.equal(t.created.length, 1);
  assert.deepEqual(openStore(t.home).entries().map(([n, e]) => [n, e.key.id]), [[101, 'M1']]);
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value, c.key.id]), [['react', '👀', 'M1']]);
  await again.onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
});

test('a message whose create never reached GitHub is forgotten at the next poll and can be reported again', async () => {
  const t = setup();
  t.faults.create = true;
  await t.bridge.onMessage(dad('M1'));
  t.faults.create = false;
  await t.bridge.poll();
  assert.ok(t.logs.some((l) => l.event === 'pending_dropped'));
  assert.equal(t.store.entries().length, 0);
  await t.bridge.onMessage(dad('M1'));
  assert.equal(t.created.length, 1);
});

test('a report written by an older bridge is not created again when its message is redelivered', async () => {
  const t = setup();
  writeFileSync(join(t.home, 'reports.json'), JSON.stringify({ 7: { key: dad('OLD').key, applied: 'triage', replies: ['BOT9'] } }));
  const again = t.restart();
  await again.onMessage(dad('OLD'));
  await again.onMessage(quoting(dad('F1', 'more'), 'BOT9'));
  assert.equal(t.created.length, 0);
  assert.deepEqual(t.comments.map((c) => c.issue), [7]);
});

test('logs carry ids but never the report text or the sender', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1', 'secret wording here'));
  const dump = JSON.stringify(t.logs);
  assert.ok(dump.includes('report_created'));
  assert.ok(!dump.includes('secret wording') && !dump.includes('15551230000'));
});

test('a photo with a caption uploads once and the issue embeds the raw url', async () => {
  const t = setup();
  await t.bridge.onMessage(photo('M1', 'The picture is cut off'));
  assert.deepEqual(t.uploaded, [{ path: 'reports/M1.jpg', size: 10 }]);
  assert.equal(t.created.length, 1);
  assert.ok(t.created[0]!.title.endsWith('The picture is cut off'));
  assert.ok(t.created[0]!.body.includes('The picture is cut off'));
  assert.ok(t.created[0]!.body.includes('![photo](https://raw.example/reports/M1.jpg)'));
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '👀']]);
});

test('a photo without a caption becomes a report titled photo', async () => {
  const t = setup();
  await t.bridge.onMessage(photo('M1'));
  assert.equal(t.created[0]!.title, 'WhatsApp report: photo');
  assert.ok(t.created[0]!.body.startsWith('![photo]('));
  assert.equal(t.store.entries().length, 1);
});

test('a photo over 10 MB is not uploaded and the report says so', async () => {
  const t = setup();
  await t.bridge.onMessage(photo('M1', 'big one', Buffer.alloc(10 * 1024 * 1024 + 1)));
  assert.equal(t.uploaded.length, 0);
  assert.ok(t.created[0]!.body.includes('(photo too large to attach)'));
  assert.ok(!t.created[0]!.body.includes('!['));
});

test('a photo whose file already exists on GitHub still creates the issue', async () => {
  const created: unknown[] = [];
  const request = (async (url: string, init: RequestInit) => {
    if (init.method === 'PUT') return new Response('{"message":"sha wasn\'t supplied"}', { status: 422 });
    if (init.method === 'GET') return new Response('{}', { status: 200 });
    created.push(JSON.parse(String(init.body)));
    return new Response('{"number":7}', { status: 201 });
  }) as unknown as typeof fetch;
  const t = setup();
  const bridge = createBridge({
    wa: { react: async () => {}, reply: async () => {} }, github: createGithub({ token: 't', repo: 'o/r' }, request),
    store: t.store, groupJid: GROUP, log: () => {},
  });
  await bridge.onMessage(photo('M1', 'again'));
  assert.equal(created.length, 1);
  assert.ok((created[0] as { body: string }).body.includes('![photo](https://raw.githubusercontent.com/o/r/benny-media/reports/M1.jpg)'));
  assert.deepEqual(t.store.entries().map(([n]) => n), [7]);
});

test('a failed upload creates no issue and no reaction, and a retry can still succeed', async () => {
  const t = setup();
  t.faults.upload = true;
  await t.bridge.onMessage(photo('M1', 'hello'));
  assert.equal(t.created.length, 0);
  assert.equal(t.calls.length, 0);
  assert.equal(t.store.entries().length, 0);
  assert.ok(t.logs.some((l) => l.event === 'issue_create_failed'));
  t.faults.upload = false;
  await t.bridge.onMessage(photo('M1', 'hello'));
  assert.equal(t.created.length, 1);
});

test('a voice note or video without text gets a thinking face and a typed-answer request, and no issue', async () => {
  const t = setup();
  await t.bridge.onMessage(voiceNote('V1'));
  await t.bridge.onMessage(voiceNote('V1'));
  assert.equal(t.created.length, 0);
  assert.equal(t.store.entries().length, 0);
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value, c.key.id]), [
    ['react', '🤔', 'V1'],
    ['reply', "🤖 I can't open voice notes, videos or view-once photos. Can you type out what happened, or send a normal photo?", 'V1'],
  ]);
});

test('unsupported media that carries text is an ordinary text report', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('V2', 'the video shows a wrong verse', GROUP, { kind: 'unsupported' }));
  assert.equal(t.created.length, 1);
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value]), [['react', '👀']]);
});

const askedForMore = async (t: ReturnType<typeof setup>) => {
  await t.bridge.onMessage(dad('M1'));
  await t.bridge.onMessage(dad('M2', 'A different problem'));
  t.label(101, 'benny:no-repro');
  t.label(102, 'benny:triage');
  await t.bridge.poll();
  t.calls.length = 0;
};

test('a quote-reply to the bot question becomes a comment on that issue and asks for re-triage', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(dad('F1', 'It happened on my phone, call 555 123 4567'), t.replyIds[0]!));
  assert.equal(t.created.length, 2);
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0]!.issue, 101);
  assert.ok(t.comments[0]!.body.startsWith('It happened on my phone'));
  assert.ok(!t.comments[0]!.body.includes('555'));
  assert.ok(t.comments[0]!.body.endsWith('\n\n<!-- wa-followup -->'));
  assert.deepEqual(t.calls.map((c) => [c.kind, c.value, c.key.id]), [['react', '👀', 'F1']]);
  assert.deepEqual(t.labelled, [{ issue: 101, label: 'benny:triage-again' }]);
  assert.ok(t.logs.some((l) => l.event === 'followup_added'));
  assert.equal(t.store.entries().length, 2);
});

test('a quote-reply to the original report comments too, and re-triages only a no-repro issue', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(dad('F1', 'more detail'), 'M2'));
  assert.deepEqual(t.comments.map((c) => c.issue), [102]);
  assert.deepEqual(t.labelled, []);
  await t.bridge.onMessage(quoting(dad('F2', 'and more'), 'M1'));
  assert.deepEqual(t.comments.map((c) => c.issue), [102, 101]);
  assert.deepEqual(t.labelled, [{ issue: 101, label: 'benny:triage-again' }]);
});

test('a quote of an unrelated message is still a new report', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(dad('M3', 'something else'), 'SOMEONE_ELSES'));
  assert.equal(t.created.length, 3);
  assert.equal(t.comments.length, 0);
});

test('a follow-up photo is uploaded and embedded in the comment', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(photo('F1', 'here it is'), t.replyIds[0]!));
  assert.deepEqual(t.uploaded.map((u) => u.path), ['reports/F1.jpg']);
  assert.ok(t.comments[0]!.body.includes('![photo](https://raw.example/reports/F1.jpg)'));
  assert.equal(t.created.length, 2);
});

test('a redelivered follow-up is commented once', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(dad('F1', 'detail'), t.replyIds[0]!));
  await t.bridge.onMessage(quoting(dad('F1', 'detail'), t.replyIds[0]!));
  assert.equal(t.comments.length, 1);
});

test('a follow-up redelivered after a restart is not commented again', async () => {
  const t = setup();
  await askedForMore(t);
  await t.bridge.onMessage(quoting(dad('F1', 'detail'), t.replyIds[0]!));
  await t.restart().onMessage(quoting(dad('F1', 'detail'), t.replyIds[0]!));
  assert.equal(t.comments.length, 1);
  assert.equal(t.calls.length, 1);
});

test('a failed re-triage label is retried at the next poll, even after a restart, until GitHub accepts it', async () => {
  const t = setup();
  await askedForMore(t);
  t.faults.label = true;
  await t.bridge.onMessage(quoting(dad('F1', 'detail'), t.replyIds[0]!));
  assert.equal(t.comments.length, 1);
  assert.deepEqual(t.labelled, []);
  assert.ok(t.logs.some((l) => l.event === 'retriage_failed'));
  const again = t.restart();
  await again.poll();
  assert.deepEqual(t.labelled, []);
  t.faults.label = false;
  await again.poll();
  await again.poll();
  assert.deepEqual(t.labelled, [{ issue: 101, label: 'benny:triage-again' }]);
  assert.equal(t.comments.length, 1);
});

test('a voice note whose reply failed is answered when it is redelivered, with the same message id', async () => {
  const t = setup();
  t.faults.replyLost = true;
  await t.bridge.onMessage(voiceNote('V1'));
  t.faults.replyLost = false;
  await t.bridge.onMessage(voiceNote('V1'));
  await t.bridge.onMessage(voiceNote('V1'));
  assert.equal(t.replyIds.length, 2);
  assert.equal(t.replyIds[0], t.replyIds[1]);
});

test('when the comment fails nothing is reacted to and the report is untouched', async () => {
  const t = setup();
  await askedForMore(t);
  t.faults.upload = true;
  await t.bridge.onMessage(quoting(photo('F1', 'here'), t.replyIds[0]!));
  assert.equal(t.comments.length, 0);
  assert.equal(t.calls.length, 0);
  assert.equal(t.created.length, 2);
  assert.ok(t.logs.some((l) => l.event === 'followup_failed'));
});

test('after a restart a quote-reply to an earlier bot question still lands on its issue', async () => {
  const t = setup();
  await askedForMore(t);
  const again = t.restart();
  await again.onMessage(quoting(dad('F1', 'after restart'), t.replyIds[0]!));
  await again.onMessage(quoting(dad('F2', 'quoting the report'), 'M2'));
  assert.deepEqual(t.comments.map((c) => c.issue), [101, 102]);
  assert.equal(t.created.length, 2);
  assert.deepEqual(t.labelled, [{ issue: 101, label: 'benny:triage-again' }]);
});

test('a status reply keeps the earlier reply ids so every bot question stays quotable', async () => {
  const t = setup();
  await t.bridge.onMessage(dad('M1'));
  t.label(101, 'benny:no-repro');
  await t.bridge.poll();
  t.label(101, 'benny:blocked');
  await t.bridge.poll();
  assert.equal(t.replyIds.length, 2);
  assert.deepEqual(t.store.entries()[0]![1].replies, t.replyIds);
});
