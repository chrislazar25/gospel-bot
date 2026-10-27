import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { z } from 'zod';

export const pool = new Pool({ connectionString: z.string().parse(process.env.DATABASE_URL) });
pool.on('error', (error: Error) => process.stderr.write(JSON.stringify({ event: 'idle_database_connection_failed', error: error.message }) + '\n'));
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += bytes.byteLength;
    if (size > 16_384) throw new HttpError(413, 'body too large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}
export function reply(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}
export function serve(route: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 500;
      if (status === 500) process.stderr.write(JSON.stringify({ event: 'request_failed', error: String(error) }) + '\n');
      reply(response, { error: status === 500 ? 'local lab failure' : String(error) }, status);
    });
  }).listen(3000, '0.0.0.0');
}
