import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDir } from './store.js';

const holderSchema = z.object({ pid: z.number().int().positive(), boot: z.number() });
export type Holder = z.infer<typeof holderSchema>;

const bootTime = () => Math.round(Date.now() / 1000 - uptime());

const read = (path: string) => {
  try { return readFileSync(path, 'utf8'); } catch { return undefined; }
};
const parse = (raw: string | undefined): Holder | undefined => {
  try { return holderSchema.parse(JSON.parse(raw ?? '')); } catch { return undefined; }
};

const isRunning = (h: Holder) => {
  // A pid recorded before the last reboot may now belong to an unrelated process.
  if (Math.abs(h.boot - bootTime()) > 120) return false;
  try { process.kill(h.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Takes BRIDGE_HOME/bridge.lock. Returns the release function, or undefined when a live bridge already holds it. */
export function acquireLock(home: string, me: Holder = { pid: process.pid, boot: bootTime() }, running = isRunning): (() => void) | undefined {
  ensurePrivateDir(home);
  const path = join(home, 'bridge.lock');
  const tmp = `${path}.${me.pid}.tmp`;
  const moved = `${path}.stale.${me.pid}`;
  writeFileSync(tmp, JSON.stringify(me), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // link() fails if the lock exists, like O_EXCL, and the lock never exists half-written.
        linkSync(tmp, path);
        return () => { if (parse(read(path))?.pid === me.pid) unlinkSync(path); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const stale = read(path);
      if (stale === undefined) continue;
      const holder = parse(stale);
      if (holder && running(holder)) return undefined;
      // Of several processes that read the same stale lock, only one can move that file.
      try { renameSync(path, moved); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (read(moved) !== stale) {
        // Another process replaced the stale lock after it was read here, so this moved its live lock. Put it back.
        try { linkSync(moved, path); } catch {}
        unlinkSync(moved);
        return undefined;
      }
      unlinkSync(moved);
    }
    return undefined;
  } finally { unlinkSync(tmp); }
}
