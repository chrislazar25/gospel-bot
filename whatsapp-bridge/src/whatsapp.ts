import { createDecipheriv } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import makeWASocket, {
  Browsers, DEF_MEDIA_HOST, DEFAULT_ORIGIN, DisconnectReason, getMediaKeys, normalizeMessageContent, type proto, toNumber,
  unixTimestampSeconds, useMultiFileAuthState, type WAMessage,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { z } from 'zod';
import type { Attachment, Incoming, Whatsapp } from './bridge.js';
import type { Log } from './log.js';
import { why } from './log.js';
import { ensurePrivateDir, type Key } from './store.js';

type Socket = ReturnType<typeof makeWASocket>;
const quiet: NonNullable<Parameters<typeof makeWASocket>[0]['logger']> = {
  level: 'silent', child: () => quiet, trace() {}, debug() {}, info() {}, warn() {}, error() {},
};
const timed = <T>(p: Promise<T>) => {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('wa_timeout')), 30000); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
};
// Disconnects where reconnecting would fight WhatsApp for the owner's personal account.
const STOP_REASONS: Partial<Record<number, string>> = {
  [DisconnectReason.loggedOut]: 'wa_logged_out',
  [DisconnectReason.connectionReplaced]: 'wa_replaced',
  [DisconnectReason.forbidden]: 'wa_forbidden',
  [DisconnectReason.multideviceMismatch]: 'wa_multidevice_mismatch',
};
const DAY = 24 * 60 * 60;
const wanted = (type: string, m: WAMessage, replayFrom: number) => {
  if (type !== 'append') return type === 'notify';
  return toNumber(m.messageTimestamp) >= Math.max(unixTimestampSeconds() - 14 * DAY, replayFrom);
};
const replaySchema = z.object({ replayFrom: z.iso.datetime() });
const lastSeenSchema = z.object({ lastSeenAt: z.iso.datetime() });
const statusOf = (e: unknown) => z.object({ output: z.object({ statusCode: z.number() }) }).safeParse(e).data?.output.statusCode;

type Content = WAMessage['message'];
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const;
// Recurses into every { message } wrapper (ephemeral, edited, ...) so a view-once nested inside another wrapper is still caught.
const isViewOnce = (c: Content, depth = 0): boolean => !!c && depth < 6 && (
  VIEW_ONCE_WRAPPERS.some((k) => c[k]) || !!(c.imageMessage?.viewOnce || c.videoMessage?.viewOnce || c.audioMessage?.viewOnce) ||
  Object.values(c).some((v) => typeof v === 'object' && v !== null && 'message' in v && isViewOnce(v.message as Content, depth + 1))
);

// The location Baileys would fetch: https://<host of url><directPath> when directPath is set (host defaults to
// mmg.whatsapp.net), else url itself. Returned only when that location is https on a whatsapp.net host.
const mediaUrl = ({ url, directPath }: proto.Message.IImageMessage): string | undefined => {
  if (directPath && !directPath.startsWith('/')) return undefined;
  const given = url ? URL.parse(url) : null;
  if (url && !given) return undefined;
  const u = URL.parse(directPath ? `https://${given?.host ?? DEF_MEDIA_HOST}${directPath}` : url ?? '');
  return u && u.protocol === 'https:' && u.hostname.endsWith('.whatsapp.net') && !u.port && !u.username && !u.password ? u.href : undefined;
};

// Baileys' downloader follows redirects to any host, so the bridge fetches the checked location itself with redirects
// refused, then decrypts as Baileys does: AES-256-CBC with keys derived from the media key, minus a trailing 10-byte MAC.
const downloadImage = async (url: string, mediaKey: Uint8Array | null | undefined) => {
  const { cipherKey, iv } = await getMediaKeys(mediaKey, 'image');
  const response = await fetch(url, { headers: { Origin: DEFAULT_ORIGIN }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`media_${response.status}`);
  const encrypted = Buffer.from(await response.arrayBuffer());
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(encrypted.subarray(0, -10)), decipher.final()]);
};

export function toIncoming(m: WAMessage, log: Log): Incoming | undefined {
  const { remoteJid, id, participant, fromMe } = m.key;
  if (!remoteJid || !id) return undefined;
  const key = { remoteJid, id, ...(participant ? { participant } : {}), fromMe: !!fromMe };
  if (isViewOnce(m.message)) return { key, text: '', quotedId: null, attachment: { kind: 'unsupported' } };
  const c = normalizeMessageContent(m.message);
  const image = c?.imageMessage;
  const text = c?.conversation || c?.extendedTextMessage?.text || image?.caption || c?.videoMessage?.caption || '';
  const url = image ? mediaUrl(image) : undefined;
  if (image && !url) log('media_url_rejected', { msg: id });
  const attachment: Attachment | null = image && url
    ? { kind: 'image', mimetype: image.mimetype || 'image/jpeg', download: () => downloadImage(url, image.mediaKey) }
    : image || c?.audioMessage || c?.videoMessage || c?.documentMessage || c?.stickerMessage ? { kind: 'unsupported' } : null;
  if (!text && !attachment) return undefined;
  const quotedId = c?.extendedTextMessage?.contextInfo?.stanzaId || image?.contextInfo?.stanzaId || null;
  return { key, text, quotedId, attachment };
}

const waKey = (k: Key) => ({ remoteJid: k.remoteJid, id: k.id, fromMe: k.fromMe, ...(k.participant ? { participant: k.participant } : {}) });

export type Connection = Whatsapp & {
  ready: Promise<void>;
  groups(): Promise<{ id: string; subject: string }[]>;
  createGroup(subject: string): Promise<{ id: string; subject: string }>;
  close(): Promise<void>;
};

export async function connectWhatsapp(o: {
  home: string; pairPhone?: string | undefined; interactive: boolean; log: Log;
  onMessage?(m: Incoming): void; onStop(): void;
}, makeSocket: typeof makeWASocket = makeWASocket): Promise<Connection> {
  const authDir = join(o.home, 'auth');
  ensurePrivateDir(o.home);
  ensurePrivateDir(authDir);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const replayPath = join(o.home, 'replay-start.json');
  const readJson = (path: string): unknown => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) {
      if (z.object({ code: z.literal('ENOENT') }).safeParse(e).success) return undefined;
      throw e;
    }
  };
  const saved = readJson(replayPath);
  const now = unixTimestampSeconds();
  const lastSeen = saved === undefined
    ? lastSeenSchema.safeParse(readJson(join(o.home, 'last-seen.json'))).data?.lastSeenAt
    : undefined;
  const replayFrom = saved === undefined
    ? Math.min(now - DAY, lastSeen ? Date.parse(lastSeen) / 1000 - 10 * 60 : now)
    : Date.parse(replaySchema.parse(saved).replayFrom) / 1000;
  // The server's backlog marker can arrive before Baileys finishes emitting messages. Keep the replay start
  // fixed and let the report ledger deduplicate redeliveries.
  if (saved === undefined && !o.interactive) {
    const tmp = `${replayPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ replayFrom: new Date(replayFrom * 1000).toISOString() }), { mode: 0o600 });
    renameSync(tmp, replayPath);
  }
  let sock: Socket | undefined;
  let connected = false, closing = false, attempt = 0;
  let markReady = () => {};
  const ready = new Promise<void>((r) => { markReady = r; });

  const start = () => {
    const s = makeSocket({
      auth: state, logger: quiet, browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    });
    sock = s;
    let asked = false;
    s.ev.on('creds.update', () => { void saveCreds().catch((e) => o.log('creds_save_failed', { error: why(e) })); });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) {
        const i = wanted(type, m, replayFrom) && toIncoming(m, o.log);
        if (i) o.onMessage?.(i);
      }
    });
    s.ev.on('connection.update', async (u) => {
      if (u.qr && !state.creds.registered) {
        if (!o.interactive) { o.log('not_linked'); o.onStop(); return; }
        if (!o.pairPhone) qrcode.generate(u.qr, { small: true }, (q) => console.log(`Scan this QR in WhatsApp, Linked devices, Link a device.\n${q}`));
        else if (!asked) {
          asked = true;
          try { console.log(`Pairing code: ${await s.requestPairingCode(o.pairPhone)}\nIn WhatsApp open Linked devices, Link a device, then Link with phone number instead.`); }
          catch (e) { asked = false; o.log('pairing_failed', { error: why(e) }); }
        }
      }
      if (u.connection === 'open') { connected = true; attempt = 0; o.log('wa_open'); markReady(); }
      if (u.connection === 'close') {
        connected = false;
        const code = statusOf(u.lastDisconnect?.error);
        o.log('wa_close', { code: code ?? 0 });
        if (closing) return;
        const stop = code === undefined ? undefined : STOP_REASONS[code];
        if (stop) { o.log(stop); o.onStop(); return; }
        const delay = Math.min(30000, 1000 * 2 ** attempt++);
        setTimeout(start, delay).unref();
      }
    });
  };
  start();

  const live = () => { if (!connected || !sock) throw new Error('wa_not_connected'); return sock; };
  return {
    ready,
    async react(key, emoji) { await timed(live().sendMessage(key.remoteJid, { react: { text: emoji, key: waKey(key) } })); },
    async reply(key, text, messageId) {
      await timed(live().sendMessage(key.remoteJid, { text }, { quoted: { key: waKey(key), message: { conversation: '' } }, messageId }));
    },
    async groups() { return Object.values(await live().groupFetchAllParticipating()).map(({ id, subject }) => ({ id, subject })); },
    async createGroup(subject) { const { id, subject: name } = await timed(live().groupCreate(subject, [])); return { id, subject: name }; },
    async close() { closing = true; await saveCreds(); await sock?.end(undefined); },
  };
}
