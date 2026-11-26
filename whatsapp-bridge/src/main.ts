import { ZodError } from 'zod';
import { createBridge } from './bridge.js';
import { linkConfig, runConfig } from './config.js';
import { createGithub } from './github.js';
import { log, why } from './log.js';
import { openStore } from './store.js';
import { connectWhatsapp } from './whatsapp.js';

const flags = process.argv.slice(2);
const onLoggedOut = () => process.exit(1);

async function link(listGroups: boolean) {
  const env = linkConfig(process.env);
  const wa = await connectWhatsapp({ home: env.BRIDGE_HOME, pairPhone: env.PAIR_PHONE, log, onLoggedOut });
  await wa.ready;
  if (listGroups) for (const g of await wa.groups()) console.log(`${g.id}\t${g.subject}`);
  else console.log('linked');
  await wa.close();
  process.exit(0);
}

async function run() {
  const env = runConfig(process.env);
  const store = openStore(env.BRIDGE_HOME);
  const github = createGithub({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO });
  let bridge: ReturnType<typeof createBridge> | undefined;
  const wa = await connectWhatsapp({
    home: env.BRIDGE_HOME, pairPhone: env.PAIR_PHONE, log, onLoggedOut,
    onMessage: (m) => { bridge?.onMessage(m).catch((e) => log('handler_failed', { error: why(e) })); },
  });
  bridge = createBridge({ wa, github, store, groupJid: env.REPORT_GROUP_JID, log });
  const ms = env.POLL_SECONDS * 1000;
  setInterval(() => { bridge?.poll().catch((e) => log('poll_crashed', { error: why(e) })); }, ms);
  setInterval(() => log('heartbeat', { reports: store.entries().length }), ms);
  log('started', { reports: store.entries().length });
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { wa.close().finally(() => process.exit(0)); });
}

const main = flags.includes('--link') ? link(false) : flags.includes('--list-groups') ? link(true) : run();
main.catch((e) => {
  log('fatal', { error: e instanceof ZodError ? 'invalid config: ' + e.issues.map((i) => i.path.join('.')).join(', ') : why(e) });
  process.exit(2);
});
