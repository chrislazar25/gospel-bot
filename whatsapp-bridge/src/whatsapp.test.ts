import assert from 'node:assert/strict';
import test from 'node:test';
import type { WAMessage } from 'baileys';
import { toIncoming } from './whatsapp.js';

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
