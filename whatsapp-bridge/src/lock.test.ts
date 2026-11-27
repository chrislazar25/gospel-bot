import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireLock, type Lock, lockPort } from './lock.js';

const tmp = () => {
  const home = join(mkdtempSync(join(tmpdir(), 'lock-')), 'home');
  mkdirSync(home);
  return home;
};
const release = async (l: Lock) => { if (l.status === 'held') await l.release(); };
const listener = (port: number, says: string) => new Promise<() => Promise<void>>((resolve) => {
  const s = createServer((c) => c.end(says));
  s.listen(port, '127.0.0.1', () => resolve(() => new Promise((r) => { s.close(() => r()); })));
});

test('a second bridge for the same home is refused while the first holds the lock', async () => {
  const home = tmp();
  const first = await acquireLock(home);
  assert.equal(first.status, 'held');
  assert.deepEqual(await acquireLock(home), { status: 'already_running', port: lockPort(realpathSync(home)) });
  await release(first);
});

test('bridges for different homes do not block each other', async () => {
  const [a, b] = [await acquireLock(tmp()), await acquireLock(tmp())];
  assert.equal(a.status, 'held');
  assert.equal(b.status, 'held');
  await release(a);
  await release(b);
});

test('a symlinked home takes the same lock as the real one', async () => {
  const home = tmp();
  const first = await acquireLock(home);
  symlinkSync(home, `${home}-link`);
  assert.equal((await acquireLock(`${home}-link`)).status, 'already_running');
  await release(first);
});

test('releasing frees the port for the next bridge', async () => {
  const home = tmp();
  const first = await acquireLock(home);
  assert.equal(first.status, 'held');
  await release(first);
  const next = await acquireLock(home);
  assert.equal(next.status, 'held');
  await release(next);
});

test('a different program on the port is reported as lock_port_taken, not as a running bridge', async () => {
  const home = tmp();
  const port = lockPort(realpathSync(home));
  const stop = await listener(port, 'SSH-2.0-OpenSSH\n');
  assert.deepEqual(await acquireLock(home), { status: 'lock_port_taken', port });
  await stop();
});

test('a bridge for another home that hashes to the same port is not mistaken for this one', async () => {
  const home = tmp();
  const port = lockPort(realpathSync(home));
  const stop = await listener(port, 'gospel-bridge /somewhere/else\n');
  assert.deepEqual(await acquireLock(home), { status: 'lock_port_taken', port });
  await stop();
});
