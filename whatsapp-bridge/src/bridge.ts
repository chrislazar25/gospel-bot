import type { Github } from './github.js';
import { type Log, why } from './log.js';
import { newIssue, type Photo, photoPath } from './report.js';
import { BOT_PREFIX, stateOf, TABLE } from './states.js';
import type { Key, Store } from './store.js';

export type Attachment = { kind: 'image'; mimetype: string; download(): Promise<Buffer> } | { kind: 'unsupported' };
export type Incoming = { key: Key; text: string; attachment: Attachment | null };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const CANT_OPEN = "I can't open voice notes or videos yet. Can you type out what happened?";

export interface Whatsapp {
  react(key: Key, emoji: string): Promise<void>;
  reply(key: Key, text: string): Promise<string>;
}

export function createBridge(d: { wa: Whatsapp; github: Github; store: Store; groupJid: string; log: Log }) {
  const { wa, github, store, groupJid, log } = d;
  const sent = new Set<string>();
  const asked = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();
  const serial = (fn: () => Promise<void>) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  const upload = async (a: Extract<Attachment, { kind: 'image' }>, id: string): Promise<Photo> => {
    const bytes = await a.download();
    return bytes.length > MAX_PHOTO_BYTES ? { tooLarge: true } : { url: await github.upload(photoPath(id, a.mimetype), bytes) };
  };

  const handle = async ({ key, text, attachment }: Incoming) => {
    const body = text.trim();
    if (key.remoteJid !== groupJid || (!body && !attachment) || sent.has(key.id) || body.startsWith(BOT_PREFIX) || store.hasMessage(key.id)) return;
    if (!body && attachment?.kind === 'unsupported') {
      if (asked.has(key.id)) return;
      asked.add(key.id);
      log('unsupported_media', { msg: key.id });
      await wa.react(key, '🤔').catch((e) => log('react_failed', { msg: key.id, error: why(e) }));
      await wa.reply(key, BOT_PREFIX + CANT_OPEN).catch((e) => log('reply_failed', { msg: key.id, error: why(e) }));
      return;
    }
    let issue: number;
    try {
      const photo = attachment?.kind === 'image' ? await upload(attachment, key.id) : undefined;
      issue = await github.create(newIssue(body, key.id, photo));
    } catch (e) {
      log('issue_create_failed', { msg: key.id, error: why(e) });
      return;
    }
    store.set(issue, { key, applied: 'new' });
    log('report_created', { issue, msg: key.id });
    await wa.react(key, TABLE.new.emoji).catch((e) => log('react_failed', { issue, error: why(e) }));
  };

  const check = async (issue: number) => {
    const entry = store.entries().find(([n]) => n === issue)?.[1];
    if (!entry) return;
    try {
      const state = stateOf(await github.get(issue));
      if (state === entry.applied) return;
      const { emoji, reply } = TABLE[state];
      await wa.react(entry.key, emoji);
      if (reply) sent.add(await wa.reply(entry.key, BOT_PREFIX + reply));
      if (TABLE[state].terminal) store.delete(issue);
      else store.set(issue, { key: entry.key, applied: state });
      log('state_applied', { issue, state });
    } catch (e) {
      log('poll_failed', { issue, error: why(e) });
    }
  };

  return {
    onMessage: (m: Incoming) => serial(() => handle(m)),
    poll: () => serial(async () => { for (const [issue] of store.entries()) await check(issue); }),
  };
}
