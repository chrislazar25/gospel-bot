import { createHash } from 'node:crypto';
import type { Github } from './github.js';
import { type Log, why } from './log.js';
import { followupBody, messageMarker, newIssue, type Photo, photoPath } from './report.js';
import { BOT_PREFIX, RETRIAGE_LABEL, type State, stateOf, TABLE } from './states.js';
import type { Entry, Key, Store } from './store.js';

export type Attachment = { kind: 'image'; mimetype: string; download(): Promise<Buffer> } | { kind: 'unsupported' };
export type Incoming = { key: Key; text: string; quotedId: string | null; attachment: Attachment | null };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const CANT_OPEN = "I can't open voice notes, videos or view-once photos. Can you type out what happened, or send a normal photo?";

export interface Whatsapp {
  react(key: Key, emoji: string): Promise<void>;
  reply(key: Key, text: string, messageId: string): Promise<void>;
}

// Same shape as Baileys' generateMessageIDV2 ('3EB0' + 18 hex digits), derived from the seed so a resend reuses the id.
export const replyId = (seed: string) => '3EB0' + createHash('sha256').update(seed).digest('hex').toUpperCase().slice(0, 18);

export function createBridge(d: { wa: Whatsapp; github: Github; store: Store; groupJid: string; log: Log }) {
  const { wa, github, store, groupJid, log } = d;
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

  const followup = async ([issue, entry]: [number, Entry], key: Key, body: string, attachment: Attachment | null) => {
    try {
      const photo = attachment?.kind === 'image' ? await upload(attachment, key.id) : undefined;
      await github.comment(issue, followupBody(body, photo));
    } catch (e) {
      log('followup_failed', { issue, msg: key.id, error: why(e) });
      return;
    }
    store.set(issue, { ...entry, retriage: true });
    store.setMessage(key.id, { status: 'done', issue, at: new Date().toISOString() });
    log('followup_added', { issue, msg: key.id });
    await wa.react(key, '👀').catch((e) => log('react_failed', { issue, error: why(e) }));
    await check(issue);
  };

  // Owed after every follow-up. Kept in the store until GitHub accepts it, so a failed label add is retried every poll.
  const retriage = async (issue: number, entry: Entry, state: State): Promise<Entry> => {
    try {
      if (state === 'no-repro') await github.addLabel(issue, RETRIAGE_LABEL);
    } catch (e) {
      log('retriage_failed', { issue, error: why(e) });
      return entry;
    }
    const settled = { ...entry, retriage: false };
    store.set(issue, settled);
    return settled;
  };

  const track = async (key: Key, issue: number) => {
    store.set(issue, { key, applied: 'new', replies: [] });
    store.setMessage(key.id, { status: 'done', issue, at: new Date().toISOString() });
    log('report_created', { issue, msg: key.id });
    await wa.react(key, TABLE.new.emoji).catch((e) => log('react_failed', { issue, error: why(e) }));
  };

  // A pending message may already have an issue: the create succeeded but its response was lost, or the bridge crashed
  // before saving it. Poll runs between messages, so by then GitHub's answer is final: adopt the issue or forget the message.
  const settle = async (id: string, key: Key) => {
    try {
      const issue = await github.findByMarker(messageMarker(id));
      if (issue) return await track(key, issue);
      store.deleteMessage(id);
      log('pending_dropped', { msg: id });
    } catch (e) {
      log('poll_failed', { msg: id, error: why(e) });
    }
  };

  const handle = async ({ key, text, quotedId, attachment }: Incoming) => {
    const body = text.trim();
    if (key.remoteJid !== groupJid || (!body && !attachment) || body.startsWith(BOT_PREFIX)) return;
    const seen = store.message(key.id);
    if (seen?.status === 'done') return;
    if (!body && attachment?.kind === 'unsupported') {
      log('unsupported_media', { msg: key.id });
      await wa.react(key, '🤔').catch((e) => log('react_failed', { msg: key.id, error: why(e) }));
      try { await wa.reply(key, BOT_PREFIX + CANT_OPEN, replyId(`cant-open:${key.id}`)); } catch (e) {
        log('reply_failed', { msg: key.id, error: why(e) });
        return;
      }
      store.setMessage(key.id, { status: 'done', at: new Date().toISOString() });
      return;
    }
    const thread = quotedId ? store.threadOf(quotedId) : undefined;
    if (thread) return followup(thread, key, body, attachment);
    let issue: number | undefined;
    try {
      store.setMessage(key.id, { status: 'pending', key, at: new Date().toISOString() });
      if (seen) issue = await github.findByMarker(messageMarker(key.id));
      issue ??= await github.create(newIssue(body, key.id, attachment?.kind === 'image' ? await upload(attachment, key.id) : undefined));
    } catch (e) {
      log('issue_create_failed', { msg: key.id, error: why(e) });
      return;
    }
    await track(key, issue);
  };

  const check = async (issue: number) => {
    let entry = store.entries().find(([n]) => n === issue)?.[1];
    if (!entry) return;
    if (entry.key.remoteJid !== groupJid) {
      store.delete(issue);
      log('stale_group', { issue });
      return;
    }
    try {
      const state = stateOf(await github.get(issue));
      if (entry.retriage) entry = await retriage(issue, entry, state);
      if (state === entry.applied && !entry.sending) return;
      // Saved before sending, so a retry after a timeout or a crash resends the same reply id instead of a new message.
      const sending = entry.sending?.state === state
        ? entry.sending
        : { state, reply: TABLE[state].reply ? replyId(`${issue}:${state}:${entry.replies.length}`) : null };
      const replies = sending.reply && !entry.replies.includes(sending.reply) ? [...entry.replies, sending.reply] : entry.replies;
      store.set(issue, { ...entry, replies, sending });
      const { emoji, reply } = TABLE[state];
      await wa.react(entry.key, emoji);
      if (reply && sending.reply) await wa.reply(entry.key, BOT_PREFIX + reply, sending.reply);
      const { sending: _, ...rest } = entry;
      if (TABLE[state].terminal) store.delete(issue);
      else store.set(issue, { ...rest, applied: state, replies });
      log('state_applied', { issue, state });
    } catch (e) {
      log('poll_failed', { issue, error: why(e) });
    }
  };

  return {
    onMessage: (m: Incoming) => serial(() => handle(m)),
    poll: () => serial(async () => {
      for (const [id, m] of store.messages()) if (m.status === 'pending') await settle(id, m.key);
      for (const [issue] of store.entries()) await check(issue);
    }),
  };
}
