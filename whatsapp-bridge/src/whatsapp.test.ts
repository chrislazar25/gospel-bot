import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import makeWASocket, { DisconnectReason, type WAMessage } from 'baileys';
import { connectWhatsapp, toIncoming } from './whatsapp.js';

const key = { remoteJid: '120363@g.us', id: 'M1', participant: '15551230000@lid', fromMe: false };
const msg = (message: NonNullable<WAMessage['message']>): WAMessage => ({ key, message });

test('plain, extended, image and video text all become reports', () => {
  for (const m of [
    { conversation: 'a' }, { extendedTextMessage: { text: 'a' } }, { imageMessage: { caption: 'a' } }, { videoMessage: { caption: 'a' } },
  ]) assert.equal(toIncoming(msg(m))?.text, 'a');
  assert.equal(toIncoming(msg({ conversation: 'a' }))?.attachment, null);
});

test('disappearing-message wrappers are unwrapped', () => {
  assert.equal(toIncoming(msg({ ephemeralMessage: { message: { conversation: 'a' } } }))?.text, 'a');
});

test('reactions, protocol messages and empty text are skipped', () => {
  assert.equal(toIncoming(msg({ reactionMessage: { text: '👍', key } })), undefined);
  assert.equal(toIncoming(msg({ protocolMessage: { type: 0 } })), undefined);
  assert.equal(toIncoming(msg({ audioMessage: {} }))?.attachment?.kind, 'unsupported');
  assert.equal(toIncoming(msg({ conversation: '' })), undefined);
  assert.equal(toIncoming({ key }), undefined);
});

test('the key keeps the sender only when there is one', () => {
  const { participant: _, ...direct } = key;
  assert.deepEqual(toIncoming({ key: { ...direct, fromMe: true }, message: { conversation: 'a' } })?.key, { remoteJid: key.remoteJid, id: 'M1', fromMe: true });
});

test('an image becomes an image attachment with its caption as text', () => {
  const i = toIncoming(msg({ imageMessage: { caption: 'look', mimetype: 'image/png' } }))!;
  assert.equal(i.text, 'look');
  assert.ok(i.attachment?.kind === 'image' && i.attachment.mimetype === 'image/png');
  const bare = toIncoming(msg({ imageMessage: {} }))!;
  assert.equal(bare.text, '');
  assert.ok(bare.attachment?.kind === 'image' && bare.attachment.mimetype === 'image/jpeg');
});

test('voice notes, videos, documents and stickers are unsupported attachments', () => {
  for (const m of [{ audioMessage: {} }, { videoMessage: {} }, { documentMessage: {} }, { stickerMessage: {} }])
    assert.deepEqual(toIncoming(msg(m)), { key, text: '', quotedId: null, attachment: { kind: 'unsupported' } });
});

test('the quoted message id comes from the text or image context', () => {
  assert.equal(toIncoming(msg({ extendedTextMessage: { text: 'a', contextInfo: { stanzaId: 'BOT1' } } }))?.quotedId, 'BOT1');
  assert.equal(toIncoming(msg({ imageMessage: { caption: 'a', contextInfo: { stanzaId: 'BOT2' } } }))?.quotedId, 'BOT2');
  assert.equal(toIncoming(msg({ extendedTextMessage: { text: 'a' } }))?.quotedId, null);
  assert.equal(toIncoming(msg({ conversation: 'a' }))?.quotedId, null);
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
