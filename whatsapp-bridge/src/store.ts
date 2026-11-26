import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { STATES } from './states.js';

export const keySchema = z.object({
  remoteJid: z.string().min(1), id: z.string().min(1), participant: z.string().min(1).optional(), fromMe: z.boolean(),
});
export type Key = z.infer<typeof keySchema>;
const entrySchema = z.object({ key: keySchema, applied: z.enum(STATES), replies: z.array(z.string()).default([]) });
export type Entry = z.infer<typeof entrySchema>;
const fileSchema = z.record(z.string().regex(/^\d+$/), entrySchema);

export type Store = {
  entries(): [number, Entry][];
  hasMessage(id: string): boolean;
  threadOf(messageId: string): [number, Entry] | undefined;
  set(issue: number, entry: Entry): void;
  delete(issue: number): void;
};

export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function openStore(home: string): Store {
  ensurePrivateDir(home);
  const path = join(home, 'reports.json');
  const data: Record<string, Entry> = existsSync(path) ? fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : {};
  const flush = () => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    entries: () => Object.entries(data).map(([n, e]) => [Number(n), e]),
    hasMessage: (id) => Object.values(data).some((e) => e.key.id === id),
    threadOf: (id) => Object.entries(data).map(([n, e]): [number, Entry] => [Number(n), e]).find(([, e]) => e.key.id === id || e.replies.includes(id)),
    set(issue, entry) { data[String(issue)] = entry; flush(); },
    delete(issue) { delete data[String(issue)]; flush(); },
  };
}
