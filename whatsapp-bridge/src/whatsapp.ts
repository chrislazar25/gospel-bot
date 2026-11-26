import { join } from 'node:path';
import makeWASocket, { Browsers, DisconnectReason, generateMessageIDV2, normalizeMessageContent, useMultiFileAuthState, type WAMessage } from 'baileys';
import qrcode from 'qrcode-terminal';
import { z } from 'zod';
import type { Incoming, Whatsapp } from './bridge.js';
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
const statusOf = (e: unknown) => z.object({ output: z.object({ statusCode: z.number() }) }).safeParse(e).data?.output.statusCode;

export function toIncoming(m: WAMessage): Incoming | undefined {
  const { remoteJid, id, participant, fromMe } = m.key;
  const c = normalizeMessageContent(m.message);
  const text = c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption;
  if (!remoteJid || !id || !text) return undefined;
  return { key: { remoteJid, id, ...(participant ? { participant } : {}), fromMe: !!fromMe }, text };
}

const waKey = (k: Key) => ({ remoteJid: k.remoteJid, id: k.id, fromMe: k.fromMe, ...(k.participant ? { participant: k.participant } : {}) });

export type Connection = Whatsapp & {
  ready: Promise<void>;
  groups(): Promise<{ id: string; subject: string }[]>;
  close(): Promise<void>;
};

export async function connectWhatsapp(o: {
  home: string; pairPhone?: string | undefined; log: Log;
  onMessage?(m: Incoming): void; onLoggedOut(): void;
}): Promise<Connection> {
  const authDir = join(o.home, 'auth');
  ensurePrivateDir(o.home);
  ensurePrivateDir(authDir);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let sock: Socket | undefined;
  let open = false, closing = false, attempt = 0;
  let markReady = () => {};
  const ready = new Promise<void>((r) => { markReady = r; });

  const start = () => {
    const s = makeWASocket({ auth: state, logger: quiet, browser: Browsers.macOS('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
    sock = s;
    let asked = false;
    s.ev.on('creds.update', () => { void saveCreds().catch((e) => o.log('creds_save_failed', { error: why(e) })); });
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) { const i = toIncoming(m); if (i) o.onMessage?.(i); }
    });
    s.ev.on('connection.update', async (u) => {
      if (u.qr && !state.creds.registered) {
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
        if (code === DisconnectReason.loggedOut) { o.log('wa_logged_out'); o.onLoggedOut(); return; }
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
    async close() { closing = true; await saveCreds(); await sock?.end(undefined); },
  };
}
