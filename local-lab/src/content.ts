import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const dateSchema = z.iso.date();
export class ContentError extends Error {
  constructor(readonly code: 'duplicate_or_mismatched_content_date' | 'invalid_content_length_or_encoding' | 'content_hash_mismatch' | 'approved_content_missing' | 'approved_content_horizon_too_short') { super(code); }
}
const manifestSchema = z.object({ schemaVersion: z.literal(1), messages: z.array(z.object({ date: dateSchema, file: z.string().regex(/^messages\/\d{4}-\d{2}-\d{2}\.txt$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()) }).strict();
export async function loadContent(directory: string) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(directory, 'schedule.json'), 'utf8')));
  const messages = new Map<string, string>();
  for (const entry of manifest.messages) {
    if (messages.has(entry.date) || entry.file !== `messages/${entry.date}.txt`) throw new ContentError('duplicate_or_mismatched_content_date');
    const bytes = await readFile(path.join(directory, entry.file));
    const payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!payload.trim() || payload.length > 20000 || payload.startsWith('\uFEFF')) throw new ContentError('invalid_content_length_or_encoding');
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new ContentError('content_hash_mismatch');
    messages.set(entry.date, payload);
  }
  function daysRemaining(first: string) {
    dateSchema.parse(first);
    let days = 0;
    while (messages.has(new Date(Date.parse(first) + days * 86400000).toISOString().slice(0, 10))) days++;
    return days;
  }
  return {
    async message(date: string) {
      const message = messages.get(date);
      if (message === undefined) throw new ContentError('approved_content_missing');
      return message;
    },
    daysRemaining,
    requireCoverage(first: string, days = 14) {
      if (daysRemaining(first) < days) throw new ContentError('approved_content_horizon_too_short');
    },
  };
}
