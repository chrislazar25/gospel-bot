import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serve, body, reply, pool, HttpError } from './http.js';

serve(async (request, response) => {
  if (request.url === '/health' && request.method === 'GET') {
    await pool.query('SELECT 1 FROM simulator.control');
    return reply(response, { ok: true, kind: 'simulator contract; not verified GreenAPI' });
  }
  if (request.url === '/send' && request.method === 'POST') {
    const data = z.object({ target: z.literal('synthetic-prayer-group'), payload: z.string().min(1) }).strict().parse(await body(request));
    const providerId = randomUUID();
    await pool.query('INSERT INTO simulator.requests(id,target,payload,accepted) VALUES($1,$2,$3,true)', [providerId, data.target, data.payload]);
    return reply(response, { providerId });
  }
  if (request.url?.startsWith('/receipt/') && request.method === 'GET') {
    const providerId = z.uuid().parse(request.url.slice('/receipt/'.length));
    const result = await pool.query<Record<string, unknown>>('SELECT receipt FROM simulator.requests WHERE id=$1 AND accepted=true', [providerId]);
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'receipt missing');
    return reply(response, { providerId, status: z.enum(['sent','delivered','read']).parse(row.receipt) });
  }
  if (request.url === '/admin/requests' && request.method === 'GET') {
    const result = await pool.query<Record<string, unknown>>('SELECT * FROM simulator.requests ORDER BY id');
    return reply(response, result.rows);
  }
  throw new HttpError(404, 'route not found');
});
