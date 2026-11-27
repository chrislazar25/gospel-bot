import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { ensurePrivateDir } from './store.js';

export type Lock =
  | { status: 'held'; port: number; release(): Promise<void> }
  | { status: 'already_running' | 'lock_port_taken'; port: number };

export const lockPort = (resolvedHome: string) => 40000 + createHash('sha256').update(resolvedHome).digest().readUInt32BE(0) % 9000;

const greeting = (home: string) => `gospel-bridge ${home}\n`;
const HOST = '127.0.0.1';

const listen = (server: Server, port: number) => new Promise<'bound' | 'in_use'>((resolve, reject) => {
  server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve('in_use') : reject(e)));
  server.listen(port, HOST, () => resolve('bound'));
});

/** What the listener on the port says, "" when it says nothing a line long, or null when nothing is listening any more. */
const ask = (port: number) => new Promise<string | null>((resolve) => {
  let said = '';
  const socket = connect(port, HOST);
  const done = (answer: string | null) => { socket.destroy(); resolve(answer); };
  socket.setTimeout(2000, () => done(''));
  socket.on('data', (d) => { said += d; if (said.endsWith('\n')) done(said); else if (said.length > 512) done(''); });
  socket.on('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' ? null : ''));
  socket.on('end', () => done(said.endsWith('\n') ? said : ''));
});

/**
 * Holds a TCP port on loopback, derived from BRIDGE_HOME, for the life of the process. The kernel frees it when the
 * process dies, so a crashed bridge never leaves a lock behind. The listener greets each connection with its home, which
 * tells another bridge for this home from an unrelated program that owns the port.
 */
export async function acquireLock(home: string): Promise<Lock> {
  ensurePrivateDir(home);
  const resolved = realpathSync(home);
  const port = lockPort(resolved);
  const hello = greeting(resolved);
  const server = createServer((c) => { c.on('error', () => {}); c.end(hello); });
  server.unref();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await listen(server, port) === 'bound') {
      return { status: 'held', port, release: () => new Promise((r) => { server.close(() => r()); }) };
    }
    const said = await ask(port);
    // null means the holder exited between our bind and our connect, so bind again.
    if (said !== null) return { status: said === hello ? 'already_running' : 'lock_port_taken', port };
  }
  return { status: 'lock_port_taken', port };
}
