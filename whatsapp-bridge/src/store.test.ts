import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore, type Entry } from './store.js';

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

test('a message id is found only while its report is stored', () => {
  const s = openStore(tmp());
  s.set(1, entry('M1'));
  assert.ok(s.hasMessage('M1'));
  assert.ok(!s.hasMessage('M2'));
  s.delete(1);
  assert.ok(!s.hasMessage('M1'));
});

test('writes are private and leave no temp file behind', () => {
  const home = tmp();
  openStore(home).set(1, entry('M1'));
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'reports.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(home), ['reports.json']);
  assert.equal(JSON.parse(readFileSync(join(home, 'reports.json'), 'utf8'))['1'].key.id, 'M1');
});

test('a corrupt file fails loudly instead of resetting', () => {
  const home = tmp();
  openStore(home);
  writeFileSync(join(home, 'reports.json'), '{"1":{"applied":"nope"}}');
  assert.throws(() => openStore(home));
});

test('a file written before replies existed still loads with no replies', () => {
  const home = tmp();
  openStore(home);
  writeFileSync(join(home, 'reports.json'), JSON.stringify({ 3: { key: entry('M1').key, applied: 'pr' } }));
  assert.deepEqual(openStore(home).entries(), [[3, entry('M1', 'pr')]]);
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
