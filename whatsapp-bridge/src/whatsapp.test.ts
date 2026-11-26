import assert from 'node:assert/strict';
import test from 'node:test';
import type { WAMessage } from 'baileys';
import { toIncoming } from './whatsapp.js';

const key = { remoteJid: '120363@g.us', id: 'M1', participant: '15551230000@lid', fromMe: false };
const msg = (message: NonNullable<WAMessage['message']>): WAMessage => ({ key, message });

test('plain, extended, image and video text all become reports', () => {
  for (const m of [
    { conversation: 'a' }, { extendedTextMessage: { text: 'a' } }, { imageMessage: { caption: 'a' } }, { videoMessage: { caption: 'a' } },
  ]) assert.deepEqual(toIncoming(msg(m)), { key, text: 'a' });
});

test('disappearing-message wrappers are unwrapped', () => {
  assert.equal(toIncoming(msg({ ephemeralMessage: { message: { conversation: 'a' } } }))?.text, 'a');
});

test('reactions, protocol messages, bare media and empty text are skipped', () => {
  assert.equal(toIncoming(msg({ reactionMessage: { text: '👍', key } })), undefined);
  assert.equal(toIncoming(msg({ protocolMessage: { type: 0 } })), undefined);
  assert.equal(toIncoming(msg({ imageMessage: {} })), undefined);
  assert.equal(toIncoming(msg({ conversation: '' })), undefined);
  assert.equal(toIncoming({ key }), undefined);
});

test('the key keeps the sender only when there is one', () => {
  const { participant: _, ...direct } = key;
  assert.deepEqual(toIncoming({ key: { ...direct, fromMe: true }, message: { conversation: 'a' } })?.key, { remoteJid: key.remoteJid, id: 'M1', fromMe: true });
});
