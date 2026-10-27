import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadContent } from './content.js';
import { checkSendPolicy, istDate } from './delivery.js';
import { greenConfigSchema } from './green-api.js';
import { policySchema } from './runtime.js';

test('disabled defaults, explicit booleans, first date, window, and IST midnight', () => {
  assert.equal(policySchema.parse({}).SENDING_ENABLED, false);
  assert.equal(policySchema.parse({ SENDING_ENABLED: 'false' }).SENDING_ENABLED, false);
  assert.throws(() => policySchema.parse({ SENDING_ENABLED: 'yes' }));
  const policy = { kind: 'scheduled', enabled: false, firstDate: '2026-10-28', startMinute: 0, endMinute: 120 } satisfies Parameters<typeof checkSendPolicy>[0];
  assert.throws(() => checkSendPolicy(policy, new Date('2026-10-27T19:00:00Z')), /sending_held/);
  assert.throws(() => checkSendPolicy({ ...policy, enabled: true }, new Date('2026-10-26T19:00:00Z')), /date_ineligible/);
  checkSendPolicy({ ...policy, enabled: true }, new Date('2026-10-27T19:00:00Z'));
  assert.throws(() => checkSendPolicy({ ...policy, enabled: true }, new Date('2026-10-27T20:30:00Z')), /outside_window/);
  assert.equal(istDate(new Date('2026-10-27T18:29:59Z')), '2026-10-27');
  assert.equal(istDate(new Date('2026-10-27T18:30:00Z')), '2026-10-28');
});

test('provider configuration rejects unapproved origins and URL credential paths', () => {
  const config = { url: 'https://7103.api.green-api.com', instanceId: '1234', token: 'test-token' };
  assert.equal(greenConfigSchema.parse(config).url, config.url);
  for (const url of ['http://api.green-api.com', 'https://evil.example', 'https://api.green-api.com.evil.example', 'https://secret@api.green-api.com', 'https://api.green-api.com/path', 'https://api.green-api.com?token=secret']) assert.throws(() => greenConfigSchema.parse({ ...config, url }));
});

test('content coverage uses exact bytes and rejects tampering, missing days, and invalid dates', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'gospel-content-'));
  try {
    await mkdir(path.join(directory, 'messages'));
    const entries = await Promise.all(Array.from({ length: 14 }, async (_, offset) => {
      const date = new Date(Date.parse('2026-10-27') + offset * 86400000).toISOString().slice(0, 10);
      const payload = `Synthetic contract fixture ${date}.\n`;
      const file = `messages/${date}.txt`;
      await writeFile(path.join(directory, file), payload);
      return { date, file, sha256: createHash('sha256').update(payload).digest('hex') };
    }));
    const save = () => writeFile(path.join(directory, 'schedule.json'), JSON.stringify({ schemaVersion: 1, messages: entries }));
    await save();
    const content = await loadContent(directory);
    content.requireCoverage('2026-10-27');
    assert.equal(content.daysRemaining('2026-10-27'), 14);
    assert.throws(() => content.requireCoverage('2026-10-28'), /horizon/);
    await assert.rejects(content.message('2026-11-11'), /missing/);
    await writeFile(path.join(directory, 'messages/2026-10-27.txt'), 'changed');
    await assert.rejects(loadContent(directory), /hash_mismatch/);
    const bom = Buffer.from('\uFEFFSynthetic message');
    await writeFile(path.join(directory, 'messages/2026-10-27.txt'), bom);
    const first = entries[0]; assert.ok(first);
    first.sha256 = createHash('sha256').update(bom).digest('hex');
    await save();
    await assert.rejects(loadContent(directory), /encoding/);
    entries[0] = { date: '2026-02-31', file: 'messages/2026-02-31.txt', sha256: '0'.repeat(64) };
    await save();
    await assert.rejects(loadContent(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
