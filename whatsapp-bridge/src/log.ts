export type Log = (event: string, fields?: Record<string, string | number>) => void;

export const log: Log = (event, fields) =>
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');

export const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 100);
