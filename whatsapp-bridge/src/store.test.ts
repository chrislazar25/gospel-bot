import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_MESSAGES, type Message, openStore, type Entry } from './store.js';

const entry = (id: string, applied: Entry['applied'] = 'new'): Entry => ({
  key: { remoteJid: '1203@g.us', id, participant: '15551234567@s.whatsapp.net', fromMe: false }, applied, replies: [],
});
const tmp = () => join(mkdtempSync(join(tmpdir(), 'bridge-')), 'home');

test('entries survive a reopen', () => {
  const home = tmp();
  const a = openStore(home);
  a.set(7, entry('M1'));
  a.set(8, entry('M2', 'pr'));
  a.delete(7);
  assert.deepEqual(openStore(home).entries(), [[8, entry('M2', 'pr')]]);
});

const done = (issue?: number): Message => ({ status: 'done', ...(issue ? { issue } : {}), at: new Date().toISOString() });

test('the message ledger survives a reopen', () => {
  const home = tmp();
  const s = openStore(home);
  s.setMessage('M1', { status: 'pending', key: entry('M1').key, at: '2026-11-26T10:00:00.000Z' });
  s.setMessage('M2', done(4));
  s.setMessage('M3', done());
  s.deleteMessage('M3');
  const again = openStore(home);
  assert.deepEqual(again.message('M1'), { status: 'pending', key: entry('M1').key, at: '2026-11-26T10:00:00.000Z' });
  assert.equal(again.message('M2')?.status, 'done');
  assert.equal(again.message('M3'), undefined);
});

test(`the ledger keeps only the newest ${MAX_MESSAGES} messages`, () => {
  const home = tmp();
  const s = openStore(home);
  for (let i = 0; i < MAX_MESSAGES + 5; i++) s.setMessage(`M${i}`, { status: 'done', at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
  const again = openStore(home);
  assert.equal(again.messages().length, MAX_MESSAGES);
  assert.equal(again.message('M4'), undefined);
  assert.ok(again.message('M5'));
  assert.ok(again.message(`M${MAX_MESSAGES + 4}`));
});

test('eviction never drops a tracked report or a pending message, however many newer messages arrive', () => {
  const home = tmp();
  const s = openStore(home);
  s.set(7, entry('REPORT'));
  s.setMessage('REPORT', { status: 'done', issue: 7, at: '2026-01-01T00:00:00.000Z' });
  s.setMessage('PENDING', { status: 'pending', key: entry('PENDING').key, at: '2026-01-01T00:00:01.000Z' });
  s.setMessage('OLD', { status: 'done', at: '2026-01-01T00:00:02.000Z' });
  for (let i = 0; i < MAX_MESSAGES + 5; i++) s.setMessage(`M${i}`, { status: 'done', at: new Date(Date.UTC(2026, 0, 2, 0, 0, i)).toISOString() });
  const again = openStore(home);
  assert.equal(again.messages().length, MAX_MESSAGES);
  assert.equal(again.message('REPORT')?.status, 'done');
  assert.equal(again.message('PENDING')?.status, 'pending');
  assert.equal(again.message('OLD'), undefined);
  s.delete(7);
  s.setMessage('NEW', done());
  assert.equal(openStore(home).message('REPORT'), undefined);
});

test('writes are private and leave no temp file behind', () => {
  const home = tmp();
  openStore(home).set(1, entry('M1'));
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'reports.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ['reports.json']);
  assert.equal(JSON.parse(readFileSync(join(home, 'reports.json'), 'utf8')).reports['1'].key.id, 'M1');
});

test('a corrupt file fails loudly instead of resetting', () => {
  const home = tmp();
  openStore(home);
  writeFileSync(join(home, 'reports.json'), '{"1":{"applied":"nope"}}');
  assert.throws(() => openStore(home));
});

test('a flat file written before the ledger loads, its messages count as done, and it is rewritten in the new shape', () => {
  const home = tmp();
  openStore(home);
  writeFileSync(join(home, 'reports.json'), JSON.stringify({ 3: { key: entry('M1').key, applied: 'pr' }, 4: entry('M2') }));
  const s = openStore(home);
  assert.deepEqual(s.entries(), [[3, entry('M1', 'pr')], [4, entry('M2')]]);
  assert.deepEqual([s.message('M1')?.status, s.message('M2')?.status], ['done', 'done']);
  s.set(5, entry('M3'));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(home, 'reports.json'), 'utf8'))), ['reports', 'messages']);
  assert.deepEqual(openStore(home).entries().map(([n]) => n), [3, 4, 5]);
});

test('a thread is found by its report id or any bot reply id', () => {
  const s = openStore(tmp());
  s.set(1, { ...entry('M1'), replies: ['BOT1', 'BOT2'] });
  s.set(2, entry('M2'));
  assert.equal(s.threadOf('M1')?.[0], 1);
  assert.equal(s.threadOf('BOT2')?.[0], 1);
  assert.equal(s.threadOf('M2')?.[0], 2);
  assert.equal(s.threadOf('nope'), undefined);
});
