import { createHash } from 'node:crypto';
import type { Github } from './github.js';
import { type Log, why } from './log.js';
import { followupBody, messageMarker, newIssue, type Photo, photoPath } from './report.js';
import { BOT_PREFIX, RETRIAGE_LABEL, type State, stateOf, TABLE } from './states.js';
import type { Entry, Key, Pending, Store } from './store.js';

export type Attachment = { kind: 'image'; mimetype: string; download(): Promise<Buffer> } | { kind: 'unsupported' };
export type Incoming = { key: Key; text: string; quotedId: string | null; attachment: Attachment | null };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MINUTE = 60 * 1000;
const CANT_OPEN = "I can't open voice notes, videos or view-once photos. Can you type out what happened, or send a normal photo?";

export interface Whatsapp {
  react(key: Key, emoji: string): Promise<void>;
  reply(key: Key, text: string, messageId: string): Promise<void>;
}

// Same shape as Baileys' generateMessageIDV2 ('3EB0' + 18 hex digits), derived from the seed so a resend reuses the id.
export const replyId = (seed: string) => '3EB0' + createHash('sha256').update(seed).digest('hex').toUpperCase().slice(0, 18);

export function createBridge(d: { wa: Whatsapp; github: Github; store: Store; groupJid: string; log: Log; now?: () => number }) {
  const { github, store, groupJid, log, now = Date.now } = d;
  const stamp = () => new Date(now()).toISOString();
  // Every send goes through here, so nothing reaches a chat other than the report group, whatever the store holds.
  const ours = (key: Key) => { if (key.remoteJid !== groupJid) throw new Error('other_chat'); };
  const wa: Whatsapp = {
    async react(key, emoji) { ours(key); await d.wa.react(key, emoji); },
    async reply(key, text, messageId) { ours(key); await d.wa.reply(key, text, messageId); },
  };
  // Left over from a bridge pointed at another group, such as a test group. Its issues stay on GitHub, untracked.
  for (const [issue, entry] of store.entries()) {
    if (entry.key.remoteJid !== groupJid) { store.delete(issue); log('stale_group', { issue }); }
  }
  for (const [id, m] of store.messages()) {
    if (m.status === 'pending' && m.key.remoteJid !== groupJid) { store.setMessage(id, { status: 'done', at: m.at }); log('stale_group', { msg: id }); }
  }
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
    store.setMessage(key.id, { status: 'done', issue, at: stamp() });
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
    store.setMessage(key.id, { status: 'done', issue, at: stamp() });
    log('report_created', { issue, msg: key.id });
    await wa.react(key, TABLE.new.emoji).catch((e) => log('react_failed', { issue, error: why(e) }));
  };

  // Any issue for the message was created after it was first recorded as pending; the margin absorbs clock skew.
  const lookup = (id: string, m: Pending) => github.findByMarker(messageMarker(id), new Date(Date.parse(m.at) - 5 * MINUTE));

  // A pending message may already have an issue: the create succeeded but its response was lost, or the bridge crashed
  // before saving it. A create can land on GitHub after its request timed out, so one miss proves nothing. The message is
  // forgotten only after two misses at least 2 minutes apart, and never within 10 minutes of being recorded.
  const settle = async (id: string, m: Pending) => {
    try {
      const issue = await lookup(id, m);
      if (issue) return await track(m.key, issue);
    } catch (e) {
      log('poll_failed', { msg: id, error: why(e) });
      return;
    }
    const t = now();
    if (!m.missedAt) store.setMessage(id, { ...m, missedAt: stamp() });
    else if (t - Date.parse(m.missedAt) >= 2 * MINUTE && t - Date.parse(m.at) >= 10 * MINUTE) {
      store.deleteMessage(id);
      log('pending_dropped', { msg: id });
    }
  };

  const handle = async ({ key, text, quotedId, attachment }: Incoming) => {
    const body = text.trim();
    if (key.remoteJid !== groupJid || (!body && !attachment) || body.startsWith(BOT_PREFIX)) return;
    const seen = store.message(key.id);
    if (seen?.status === 'done' || store.threadOf(key.id)) return;
    if (!body && attachment?.kind === 'unsupported') {
      log('unsupported_media', { msg: key.id });
      await wa.react(key, '🤔').catch((e) => log('react_failed', { msg: key.id, error: why(e) }));
      try { await wa.reply(key, BOT_PREFIX + CANT_OPEN, replyId(`cant-open:${key.id}`)); } catch (e) {
        log('reply_failed', { msg: key.id, error: why(e) });
        return;
      }
      store.setMessage(key.id, { status: 'done', at: stamp() });
      return;
    }
    const thread = quotedId ? store.threadOf(quotedId) : undefined;
    if (thread) return followup(thread, key, body, attachment);
    let issue: number | undefined;
    try {
      // A redelivery keeps the first time, which bounds the lookup, and starts counting misses again.
      const pending: Pending = { status: 'pending', key, at: seen?.at ?? stamp() };
      store.setMessage(key.id, pending);
      if (seen) issue = await lookup(key.id, pending);
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
      for (const [id, m] of store.messages()) if (m.status === 'pending') await settle(id, m);
      for (const [issue] of store.entries()) await check(issue);
    }),
  };
}
