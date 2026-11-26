import { join } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, generateMessageIDV2, normalizeMessageContent, type proto, useMultiFileAuthState, type WAMessage } from 'baileys';
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
const statusOf = (e: unknown) => z.object({ output: z.object({ statusCode: z.number() }) }).safeParse(e).data?.output.statusCode;

type Content = WAMessage['message'];
const VIEW_ONCE_WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const;
// Recurses into every { message } wrapper (ephemeral, edited, ...) so a view-once nested inside another wrapper is still caught.
const isViewOnce = (c: Content, depth = 0): boolean => !!c && depth < 6 && (
  VIEW_ONCE_WRAPPERS.some((k) => c[k]) || !!(c.imageMessage?.viewOnce || c.videoMessage?.viewOnce || c.audioMessage?.viewOnce) ||
  Object.values(c).some((v) => typeof v === 'object' && v !== null && 'message' in v && isViewOnce(v.message as Content, depth + 1))
);

// Baileys fetches https://<host of url><directPath> when directPath is set (host defaults to mmg.whatsapp.net), else url itself.
const fromWhatsappServers = ({ url, directPath }: { url?: string | null; directPath?: string | null }) => {
  if ((!url && !directPath) || (directPath && !directPath.startsWith('/'))) return false;
  if (!url) return true;
  const u = URL.parse(url);
  return !!u && u.protocol === 'https:' && u.hostname.endsWith('.whatsapp.net') && !u.port && !u.username && !u.password;
};

// Passes Baileys only the checked fields. Other keys in the message, or a missing url (which makes Baileys fall back to
// thumbnailDirectPath), would fetch something the check never saw.
const downloadChecked = (key: WAMessage['key'], i: proto.Message.IImageMessage) => downloadMediaMessage(
  { key, message: { imageMessage: { url: i.url ?? null, directPath: i.directPath ?? null, mediaKey: i.mediaKey ?? null } } }, 'buffer', {},
);

export function toIncoming(m: WAMessage, log: Log): Incoming | undefined {
  const { remoteJid, id, participant, fromMe } = m.key;
  if (!remoteJid || !id) return undefined;
  const key = { remoteJid, id, ...(participant ? { participant } : {}), fromMe: !!fromMe };
  if (isViewOnce(m.message)) return { key, text: '', quotedId: null, attachment: { kind: 'unsupported' } };
  const c = normalizeMessageContent(m.message);
  const image = c?.imageMessage;
  const text = c?.conversation || c?.extendedTextMessage?.text || image?.caption || c?.videoMessage?.caption || '';
  const checked = image && fromWhatsappServers(image) ? image : undefined;
  if (image && !checked) log('media_url_rejected', { msg: id });
  const attachment: Attachment | null = checked
    ? { kind: 'image', mimetype: checked.mimetype || 'image/jpeg', download: () => downloadChecked(m.key, checked) }
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
  let sock: Socket | undefined;
  let open = false, closing = false, attempt = 0;
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
      if (type !== 'notify') return;
      for (const m of messages) { const i = toIncoming(m, o.log); if (i) o.onMessage?.(i); }
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
      if (u.connection === 'open') { open = true; attempt = 0; o.log('wa_open'); markReady(); }
      if (u.connection === 'close') {
        open = false;
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

  const live = () => { if (!open || !sock) throw new Error('wa_not_connected'); return sock; };
  return {
    ready,
    async react(key, emoji) { await timed(live().sendMessage(key.remoteJid, { react: { text: emoji, key: waKey(key) } })); },
    async reply(key, text) {
      const s = live();
      const messageId = generateMessageIDV2(s.user?.id);
      await timed(s.sendMessage(key.remoteJid, { text }, { quoted: { key: waKey(key), message: { conversation: '' } }, messageId }));
      return messageId;
    },
    async groups() { return Object.values(await live().groupFetchAllParticipating()).map(({ id, subject }) => ({ id, subject })); },
    async createGroup(subject) { const { id, subject: name } = await timed(live().groupCreate(subject, [])); return { id, subject: name }; },
    async close() { closing = true; await saveCreds(); await sock?.end(undefined); },
  };
}
