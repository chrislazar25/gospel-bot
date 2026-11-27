import { ZodError } from 'zod';
import { createBridge } from './bridge.js';
import { linkConfig, runConfig } from './config.js';
import { createGithub } from './github.js';
import { acquireLock } from './lock.js';
import { log, why } from './log.js';
import { openStore } from './store.js';
import { type Connection, connectWhatsapp } from './whatsapp.js';

const flags = process.argv.slice(2);
const onStop = () => process.exit(3);

async function holdLock(home: string) {
  const lock = await acquireLock(home);
  if (lock.status !== 'held') { log(lock.status, { port: lock.port }); process.exit(2); }
}

async function interactive(action: (wa: Connection) => Promise<void>) {
  const env = linkConfig(process.env);
  await holdLock(env.BRIDGE_HOME);
  const wa = await connectWhatsapp({ home: env.BRIDGE_HOME, pairPhone: env.PAIR_PHONE, interactive: true, log, onStop });
  await wa.ready;
  await action(wa);
  await wa.close();
  process.exit(0);
}

const link = () => interactive(async () => console.log('linked'));
const listGroups = () => interactive(async (wa) => { for (const g of await wa.groups()) console.log(`${g.id}\t${g.subject}`); });

async function createGroup(subject: string | undefined) {
  if (!subject || subject.startsWith('--')) throw new Error('usage: --create-group "<subject>"');
  return interactive(async (wa) => {
    const g = await wa.createGroup(subject).catch((e) => { throw new Error(`group_create_failed: ${why(e)}`); });
    console.log(`${g.id}\t${g.subject}`);
  });
}

async function run() {
  const env = runConfig(process.env);
  await holdLock(env.BRIDGE_HOME);
  const store = openStore(env.BRIDGE_HOME);
  const github = createGithub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO });
  let bridge: ReturnType<typeof createBridge> | undefined;
  const wa = await connectWhatsapp({
    home: env.BRIDGE_HOME, interactive: false, log, onStop,
    onMessage: (m) => { bridge?.onMessage(m).catch((e) => log('handler_failed', { error: why(e) })); },
  });
  bridge = createBridge({ wa, github, store, groupJid: env.REPORT_GROUP_JID, log });
  const ms = env.POLL_SECONDS * 1000;
  setInterval(() => { bridge?.poll().catch((e) => log('poll_crashed', { error: why(e) })); }, ms);
  setInterval(() => log('heartbeat', { reports: store.entries().length }), ms);
  log('started', { reports: store.entries().length });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { wa.close().finally(() => process.exit(0)); });
}

const create = flags.indexOf('--create-group');
const main = flags.includes('--link') ? link() : flags.includes('--list-groups') ? listGroups() : create >= 0 ? createGroup(flags[create + 1]) : run();
main.catch((e) => {
  log('fatal', { error: e instanceof ZodError ? 'invalid config: ' + e.issues.map((i) => i.path.join('.')).join(', ') : why(e) });
  process.exit(2);
});
