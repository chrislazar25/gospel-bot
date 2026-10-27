import { createServer } from 'node:http';
import type { Pool } from 'pg';
import { z } from 'zod';
import { deliverySchema, istDate } from './delivery.js';
import { checkSchema } from './migrate.js';

export async function readStatus(db: Pool, date: string) {
  const result = await db.query<Record<string, unknown>>('SELECT * FROM deliveries WHERE date=$1 ORDER BY created_at', [date]);
  return result.rows.map(value => {
    const row = deliverySchema.parse(value);
    return { id: row.id, date: row.date, status: row.status, attempts: row.attempts, payloadHash: row.payload_hash, evidence: row.evidence };
  });
}
export function createStatusServer(db: Pool, revision: string) {
  return createServer((request, response) => {
    const respond = (code: number, data: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
    };
    void (async () => {
      if (request.method !== 'GET') return respond(405, { error: 'GET required' });
      if (request.url === '/health') {
        await checkSchema(db);
        return respond(200, { ok: true, revision });
      }
      if (request.url === '/status') {
        const date = istDate(new Date());
        return respond(200, { date, revision, deliveries: await readStatus(db, date) });
      }
      if (request.url?.startsWith('/get-status/')) {
        const id = z.uuid().parse(request.url.slice('/get-status/'.length));
        const result = await db.query<Record<string, unknown>>('SELECT * FROM deliveries WHERE id=$1', [id]);
        const row = result.rows[0];
        if (!row) return respond(404, { error: 'delivery not found' });
        const parsed = deliverySchema.parse(row);
        return respond(200, { id: parsed.id, date: parsed.date, status: parsed.status, attempts: parsed.attempts, payloadHash: parsed.payload_hash, evidence: parsed.evidence });
      }
      return respond(404, { error: 'route not found' });
    })().catch(error => {
      respond(error instanceof z.ZodError ? 400 : 503, { error: error instanceof z.ZodError ? 'invalid request' : 'database unavailable' });
    });
  });
}
