import type { Github } from './github.js';
import { type Log, why } from './log.js';
import { followupBody, newIssue, type Photo, photoPath } from './report.js';
import { BOT_PREFIX, RETRIAGE_LABEL, stateOf, TABLE } from './states.js';
import type { Key, Store } from './store.js';

export type Attachment = { kind: 'image'; mimetype: string; download(): Promise<Buffer> } | { kind: 'unsupported' };
export type Incoming = { key: Key; text: string; quotedId: string | null; attachment: Attachment | null };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const CANT_OPEN = "I can't open voice notes, videos or view-once photos. Can you type out what happened, or send a normal photo?";

export interface Whatsapp {
  react(key: Key, emoji: string): Promise<void>;
  reply(key: Key, text: string): Promise<string>;
}

export function createBridge(d: { wa: Whatsapp; github: Github; store: Store; groupJid: string; log: Log }) {
  const { wa, github, store, groupJid, log } = d;
  const handled = new Set<string>();
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

  const followup = async (issue: number, key: Key, body: string, attachment: Attachment | null) => {
    try {
      const photo = attachment?.kind === 'image' ? await upload(attachment, key.id) : undefined;
      await github.comment(issue, followupBody(body, photo));
    } catch (e) {
      log('followup_failed', { issue, msg: key.id, error: why(e) });
      return;
    }
    handled.add(key.id);
    log('followup_added', { issue, msg: key.id });
    await wa.react(key, '👀').catch((e) => log('react_failed', { issue, error: why(e) }));
    try { if (stateOf(await github.get(issue)) === 'no-repro') await github.addLabel(issue, RETRIAGE_LABEL); } catch (e) {
      log('retriage_failed', { issue, error: why(e) });
    }
  };

  const handle = async ({ key, text, quotedId, attachment }: Incoming) => {
    const body = text.trim();
    if (key.remoteJid !== groupJid || (!body && !attachment) || handled.has(key.id) || body.startsWith(BOT_PREFIX) || store.hasMessage(key.id)) return;
    if (!body && attachment?.kind === 'unsupported') {
      handled.add(key.id);
      log('unsupported_media', { msg: key.id });
      await wa.react(key, '🤔').catch((e) => log('react_failed', { msg: key.id, error: why(e) }));
      await wa.reply(key, BOT_PREFIX + CANT_OPEN).catch((e) => log('reply_failed', { msg: key.id, error: why(e) }));
      return;
    }
    const thread = quotedId ? store.threadOf(quotedId) : undefined;
    if (thread) return followup(thread[0], key, body, attachment);
    let issue: number;
    try {
      const photo = attachment?.kind === 'image' ? await upload(attachment, key.id) : undefined;
      issue = await github.create(newIssue(body, key.id, photo));
    } catch (e) {
      log('issue_create_failed', { msg: key.id, error: why(e) });
      return;
    }
    store.set(issue, { key, applied: 'new', replies: [] });
    log('report_created', { issue, msg: key.id });
    await wa.react(key, TABLE.new.emoji).catch((e) => log('react_failed', { issue, error: why(e) }));
  };

  const check = async (issue: number) => {
    const entry = store.entries().find(([n]) => n === issue)?.[1];
    if (!entry) return;
    if (entry.key.remoteJid !== groupJid) {
      store.delete(issue);
      log('stale_group', { issue });
      return;
    }
    try {
      const state = stateOf(await github.get(issue));
      if (state === entry.applied) return;
      const { emoji, reply } = TABLE[state];
      await wa.react(entry.key, emoji);
      const replies = reply ? [...entry.replies, await wa.reply(entry.key, BOT_PREFIX + reply)] : entry.replies;
      if (TABLE[state].terminal) store.delete(issue);
      else store.set(issue, { key: entry.key, applied: state, replies });
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
