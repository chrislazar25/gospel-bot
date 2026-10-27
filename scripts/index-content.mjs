import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../content/', import.meta.url);
const directory = new URL('messages/', root);
const files = await readdir(directory);
const messages = [];
for (const file of files.sort()) {
  if (file === '.gitkeep') continue;
  if (!/^\d{4}-\d{2}-\d{2}\.txt$/.test(file)) throw new Error(`Unexpected content filename: ${file}`);
  const bytes = await readFile(new URL(file, directory));
  messages.push({ date: file.slice(0, 10), file: `messages/${file}`, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(new URL('schedule.json', root), JSON.stringify({ schemaVersion: 1, messages }, null, 2) + '\n');
process.stdout.write(`Indexed ${messages.length} messages for review.\n`);
