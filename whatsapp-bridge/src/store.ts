import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STATES } from './states.js';

export const keySchema = z.object({
  remoteJid: z.string().min(1), id: z.string().min(1), participant: z.string().min(1).optional(), fromMe: z.boolean(),
});
export type Key = z.infer<typeof keySchema>;
const entrySchema = z.object({
  key: keySchema, applied: z.enum(STATES), replies: z.array(z.string()).default([]),
  // A state change saved but not yet confirmed sent to WhatsApp, with the id its reply will use.
  sending: z.object({ state: z.enum(STATES), reply: z.string().nullable() }).optional(),
});
export type Entry = z.infer<typeof entrySchema>;
// pending: an issue may exist on GitHub for this message but the bridge has not confirmed it. done: nothing left to do.
const messageSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), key: keySchema, at: z.string() }),
  z.object({ status: z.literal('done'), issue: z.number().int().positive().optional(), at: z.string() }),
]);
export type Message = z.infer<typeof messageSchema>;
const reportsSchema = z.record(z.string().regex(/^\d+$/), entrySchema);
const fileSchema = z.union([
  z.object({ reports: reportsSchema, messages: z.record(z.string(), messageSchema) }),
  // Files written before the message ledger were a flat map of reports. Their messages are already handled.
  reportsSchema.transform((reports) => ({
    reports,
    messages: Object.fromEntries(Object.entries(reports).map(([n, e]): [string, Message] => [e.key.id, { status: 'done', issue: Number(n), at: new Date().toISOString() }])),
  })),
]);
export const MAX_MESSAGES = 1000;

export type Store = {
  entries(): [number, Entry][];
  threadOf(messageId: string): [number, Entry] | undefined;
  set(issue: number, entry: Entry): void;
  delete(issue: number): void;
  messages(): [string, Message][];
  message(id: string): Message | undefined;
  setMessage(id: string, message: Message): void;
  deleteMessage(id: string): void;
};

export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function openStore(home: string): Store {
  ensurePrivateDir(home);
  const path = join(home, 'reports.json');
  const { reports, messages } = existsSync(path) ? fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : { reports: {}, messages: {} };
  const flush = () => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ reports, messages }, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const entries = () => Object.entries(reports).map(([n, e]): [number, Entry] => [Number(n), e]);
  return {
    entries,
    threadOf: (id) => entries().find(([, e]) => e.key.id === id || e.replies.includes(id)),
    set(issue, entry) { reports[String(issue)] = entry; flush(); },
    delete(issue) { delete reports[String(issue)]; flush(); },
    messages: () => Object.entries(messages),
    message: (id) => messages[id],
    setMessage(id, message) {
      messages[id] = message;
      const oldest = Object.entries(messages).sort(([, a], [, b]) => a.at.localeCompare(b.at));
      for (const [old] of oldest.slice(0, Math.max(0, oldest.length - MAX_MESSAGES))) delete messages[old];
      flush();
    },
    deleteMessage(id) { delete messages[id]; flush(); },
  };
}
