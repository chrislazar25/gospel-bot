import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import makeWASocket, { DisconnectReason, type WAMessage } from 'baileys';
import { connectWhatsapp, toIncoming } from './whatsapp.js';

const incoming = (m: WAMessage) => toIncoming(m, () => {});

const key = { remoteJid: '120363@g.us', id: 'M1', participant: '15551230000@lid', fromMe: false };
const media = { url: 'https://mmg.whatsapp.net/v/t62/abc?ccb=11', directPath: '/v/t62/abc?ccb=11' };
const msg = (message: NonNullable<WAMessage['message']>): WAMessage => ({ key, message });

test('plain, extended, image and video text all become reports', () => {
  for (const m of [
    { conversation: 'a' }, { extendedTextMessage: { text: 'a' } }, { imageMessage: { caption: 'a' } }, { videoMessage: { caption: 'a' } },
  ]) assert.equal(incoming(msg(m))?.text, 'a');
  assert.equal(incoming(msg({ conversation: 'a' }))?.attachment, null);
});

test('disappearing-message wrappers are unwrapped', () => {
  assert.equal(incoming(msg({ ephemeralMessage: { message: { conversation: 'a' } } }))?.text, 'a');
});

test('reactions, protocol messages and empty text are skipped', () => {
  assert.equal(incoming(msg({ reactionMessage: { text: '👍', key } })), undefined);
  assert.equal(incoming(msg({ protocolMessage: { type: 0 } })), undefined);
  assert.equal(incoming(msg({ audioMessage: {} }))?.attachment?.kind, 'unsupported');
  assert.equal(incoming(msg({ conversation: '' })), undefined);
  assert.equal(incoming({ key }), undefined);
});

test('the key keeps the sender only when there is one', () => {
  const { participant: _, ...direct } = key;
  assert.deepEqual(incoming({ key: { ...direct, fromMe: true }, message: { conversation: 'a' } })?.key, { remoteJid: key.remoteJid, id: 'M1', fromMe: true });
});

test('an image becomes an image attachment with its caption as text', () => {
  const i = incoming(msg({ imageMessage: { ...media, caption: 'look', mimetype: 'image/png' } }))!;
  assert.equal(i.text, 'look');
  assert.ok(i.attachment?.kind === 'image' && i.attachment.mimetype === 'image/png');
  const bare = incoming(msg({ imageMessage: media }))!;
  assert.equal(bare.text, '');
  assert.ok(bare.attachment?.kind === 'image' && bare.attachment.mimetype === 'image/jpeg');
});

test('voice notes, videos, documents and stickers are unsupported attachments', () => {
  for (const m of [{ audioMessage: {} }, { videoMessage: {} }, { documentMessage: {} }, { stickerMessage: {} }])
    assert.deepEqual(incoming(msg(m)), { key, text: '', quotedId: null, attachment: { kind: 'unsupported' } });
});

test('view-once media is never an image attachment and its caption is dropped', () => {
  const image = { caption: 'my number is on screen', mimetype: 'image/png', url: 'https://mmg.whatsapp.net/x', directPath: '/x' };
  const unsupported = { key, text: '', quotedId: null, attachment: { kind: 'unsupported' } };
  for (const m of [
    { viewOnceMessage: { message: { imageMessage: image } } },
    { viewOnceMessageV2: { message: { imageMessage: image } } },
    { viewOnceMessageV2Extension: { message: { imageMessage: image } } },
    { imageMessage: { ...image, viewOnce: true } },
    { videoMessage: { caption: 'clip', viewOnce: true } },
    { ephemeralMessage: { message: { viewOnceMessageV2: { message: { imageMessage: image } } } } },
    { ephemeralMessage: { message: { imageMessage: { ...image, viewOnce: true } } } },
  ]) assert.deepEqual(incoming(msg(m)), unsupported, JSON.stringify(m));
});

test('a photo quoting a view-once message is still an ordinary photo', () => {
  const quoted = { viewOnceMessageV2: { message: { imageMessage: { viewOnce: true } } } };
  const i = incoming(msg({ imageMessage: { ...media, caption: 'see', contextInfo: { stanzaId: 'Q1', quotedMessage: quoted } } }))!;
  assert.equal(i.attachment?.kind, 'image');
});

test('an image is downloaded only from a WhatsApp https host and an absolute direct path', () => {
  const kind = (image: object) => {
    const events: string[] = [];
    const k = toIncoming(msg({ imageMessage: { caption: 'look', ...image } }), (e) => events.push(e))?.attachment?.kind;
    assert.deepEqual(events, k === 'image' ? [] : ['media_url_rejected'], JSON.stringify(image));
    return k;
  };
  assert.equal(kind(media), 'image');
  assert.equal(kind({ url: media.url }), 'image');
  assert.equal(kind({ directPath: media.directPath }), 'image');
  assert.equal(kind({ url: 'https://media-lhr8-1.cdn.whatsapp.net/v/x', directPath: media.directPath }), 'image');
  for (const bad of [
    {}, { url: 'http://mmg.whatsapp.net/x' }, { url: 'https://169.254.169.254/latest' }, { url: 'https://localhost/x', directPath: '/x' },
    { url: 'https://whatsapp.net.evil.com/x' }, { url: 'https://evilwhatsapp.net/x' }, { url: 'https://mmg.whatsapp.net:8443/x' },
    { url: 'https://user@mmg.whatsapp.net/x' }, { url: 'not a url', directPath: '/x' }, { directPath: '@10.0.0.1/x' }, { url: media.url, directPath: '.evil.com/x' },
  ]) assert.equal(kind(bad), 'unsupported');
});

test('the download fetches exactly the checked location, never another field of the message', async () => {
  const fetched: string[] = [];
  const fetch = mock.method(globalThis, 'fetch', async (url: string) => { fetched.push(String(url)); return new Response('', { status: 404 }); });
  try {
    const mediaKey = new Uint8Array(32);
    for (const [image, expected] of [
      [{ ...media, mediaKey, thumbnailDirectPath: '@169.254.169.254/x' }, `https://mmg.whatsapp.net${media.directPath}`],
      [{ url: media.url, mediaKey, thumbnailDirectPath: '@169.254.169.254/x' }, media.url],
      [{ url: 'https://media-lhr8-1.cdn.whatsapp.net/v/x', directPath: '/d', mediaKey }, 'https://media-lhr8-1.cdn.whatsapp.net/d'],
    ] as const) {
      const message = { videoMessage: { url: 'https://169.254.169.254/evil', mediaKey }, imageMessage: image };
      const a = incoming(msg(message))?.attachment;
      assert.ok(a?.kind === 'image');
      await assert.rejects(a.download());
      assert.equal(fetched.pop(), expected);
    }
  } finally { fetch.mock.restore(); }
});

test('the quoted message id comes from the text or image context', () => {
  assert.equal(incoming(msg({ extendedTextMessage: { text: 'a', contextInfo: { stanzaId: 'BOT1' } } }))?.quotedId, 'BOT1');
  assert.equal(incoming(msg({ imageMessage: { ...media, caption: 'a', contextInfo: { stanzaId: 'BOT2' } } }))?.quotedId, 'BOT2');
  assert.equal(incoming(msg({ extendedTextMessage: { text: 'a' } }))?.quotedId, null);
  assert.equal(incoming(msg({ conversation: 'a' }))?.quotedId, null);
});

function fakeSocket() {
  const handlers = new Map<string, (u: unknown) => unknown>();
  const seen: { options?: Parameters<typeof makeWASocket>[0]; pairing: string[]; groupCreate: [string, string[]][] } = { pairing: [], groupCreate: [] };
  const socket = ((options: Parameters<typeof makeWASocket>[0]) => {
    seen.options = options;
    return {
      ev: { on: (event: string, fn: (u: unknown) => unknown) => { handlers.set(event, fn); } },
      requestPairingCode: async (phone: string) => { seen.pairing.push(phone); return 'CODE'; },
      groupCreate: async (subject: string, participants: string[]) => { seen.groupCreate.push([subject, participants]); return { id: '1203@g.us', subject, extra: 1 }; },
      end: async () => {},
    };
  }) as unknown as typeof makeWASocket;
  return { socket, seen, emit: (u: object) => handlers.get('connection.update')!(u) };
}
const connect = async (interactive: boolean, pairPhone?: string) => {
  const f = fakeSocket();
  const events: string[] = [];
  let unlinked = 0;
  const wa = await connectWhatsapp(
    { home: join(mkdtempSync(join(tmpdir(), 'wa-')), 'home'), interactive, pairPhone, log: (e) => events.push(e), onUnlinked: () => { unlinked++; } },
    f.socket,
  );
  return { ...f, wa, events, unlinked: () => unlinked };
};

test('run mode never prints a QR or pairs: an unlinked session logs and stops', async () => {
  const c = await connect(false, '15551230000');
  await c.emit({ qr: 'qr-data' });
  assert.deepEqual(c.events, ['not_linked']);
  assert.equal(c.unlinked(), 1);
  assert.deepEqual(c.seen.pairing, []);
});

test('link mode asks for a pairing code instead of stopping', async () => {
  const log = mock.method(console, 'log', () => {});
  try {
    const c = await connect(true, '15551230000');
    await c.emit({ qr: 'qr-data' });
    assert.deepEqual(c.seen.pairing, ['15551230000']);
    assert.equal(c.unlinked(), 0);
  } finally { log.mock.restore(); }
});

test('being logged out stops the bridge instead of reconnecting', async () => {
  const c = await connect(false);
  await c.emit({ connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  assert.deepEqual(c.events, ['wa_close', 'wa_logged_out']);
  assert.equal(c.unlinked(), 1);
});

test('the socket never marks the owner online and never syncs history', async () => {
  const { options } = (await connect(false)).seen;
  assert.equal(options?.markOnlineOnConnect, false);
  assert.equal(options?.syncFullHistory, false);
  assert.equal(options?.shouldSyncHistoryMessage?.({} as never), false);
});

test('creating a group sends an empty participant list and returns the id and subject', async () => {
  const c = await connect(true);
  await c.emit({ connection: 'open' });
  assert.deepEqual(await c.wa.createGroup('Gospel Bot help'), { id: '1203@g.us', subject: 'Gospel Bot help' });
  assert.deepEqual(c.seen.groupCreate, [['Gospel Bot help', []]]);
});
