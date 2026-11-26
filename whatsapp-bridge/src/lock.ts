import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ensurePrivateDir } from './store.js';

const holderSchema = z.object({ pid: z.number().int().positive(), boot: z.number() });
type Holder = z.infer<typeof holderSchema>;

const bootTime = () => Math.round(Date.now() / 1000 - uptime());

const readHolder = (path: string): Holder | undefined => {
  try { return holderSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); } catch { return undefined; }
};

const running = (h: Holder) => {
  // A pid recorded before the last reboot may now belong to an unrelated process.
  if (Math.abs(h.boot - bootTime()) > 120) return false;
  try { process.kill(h.pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Takes BRIDGE_HOME/bridge.lock. Returns the release function, or undefined when a live bridge already holds it. */
export function acquireLock(home: string): (() => void) | undefined {
  ensurePrivateDir(home);
  const path = join(home, 'bridge.lock');
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, boot: bootTime() }), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // link() fails if the lock exists, like O_EXCL, and the lock never exists half-written.
        linkSync(tmp, path);
        return () => { if (readHolder(path)?.pid === process.pid) unlinkSync(path); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = readHolder(path);
        if (holder && running(holder)) return undefined;
        unlinkSync(path);
      }
    }
    return undefined;
  } finally { unlinkSync(tmp); }
}
