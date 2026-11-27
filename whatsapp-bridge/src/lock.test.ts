import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireLock } from './lock.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'lock-')), 'home');
const boot = Math.round(Date.now() / 1000 - uptime());
const holderPid = (home: string) => JSON.parse(readFileSync(join(home, 'bridge.lock'), 'utf8')).pid;

test('a second bridge cannot start while the first holds the lock, and can after it releases', () => {
  const home = tmp();
  const release = acquireLock(home);
  assert.ok(release);
  assert.equal(holderPid(home), process.pid);
  assert.equal(acquireLock(home), undefined);
  release();
  assert.ok(!existsSync(join(home, 'bridge.lock')));
  assert.ok(acquireLock(home));
  assert.deepEqual(readdirSync(home), ['bridge.lock']);
});

test('a lock left by a dead process, a previous boot or a garbled write is replaced', () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  for (const content of [
    JSON.stringify({ pid: dead, boot }), JSON.stringify({ pid: process.pid, boot: boot - 86400 }), '', 'not json',
  ]) {
    const home = tmp();
    acquireLock(home)!();
    writeFileSync(join(home, 'bridge.lock'), content);
    assert.ok(acquireLock(home), content);
    assert.equal(holderPid(home), process.pid);
  }
});

test('two bridges that both find the same stale lock cannot both take it', () => {
  const home = tmp();
  acquireLock(home)!();
  writeFileSync(join(home, 'bridge.lock'), JSON.stringify({ pid: 999999, boot }));
  // The manual run reads the stale lock, and launchd's bridge takes it over before the manual run acts on what it read.
  let launchd: (() => void) | undefined;
  const manual = acquireLock(home, { pid: 1001, boot }, (h) => {
    launchd ??= acquireLock(home, { pid: 1002, boot }, (stale) => stale.pid === 1001);
    return h.pid === 1002;
  });
  assert.equal([manual, launchd].filter(Boolean).length, 1);
  assert.equal(holderPid(home), launchd ? 1002 : 1001);
  assert.deepEqual(readdirSync(home), ['bridge.lock']);
  assert.equal(acquireLock(home, { pid: 1003, boot }, (h) => h.pid === 1001 || h.pid === 1002), undefined);
});

test('releasing never removes a lock another process has taken over', () => {
  const home = tmp();
  const release = acquireLock(home)!;
  writeFileSync(join(home, 'bridge.lock'), JSON.stringify({ pid: 1, boot }));
  release();
  assert.equal(holderPid(home), 1);
});
