import { z } from 'zod';
import { serve, body, reply, pool, HttpError } from './http.js';
import { sendToday, status } from './core.js';

serve(async (request, response) => {
  if (request.url === '/health' && request.method === 'GET') {
    await pool.query('SELECT 1 FROM deliveries LIMIT 1');
    return reply(response, { ok: true, kind: 'local simulator lab' });
  }
  if (request.url === '/send-todays-message') {
    if (request.method !== 'POST') throw new HttpError(405, 'POST required');
    z.object({}).strict().parse(await body(request));
    return reply(response, await sendToday());
  }
  if (request.url?.startsWith('/get-status/')) {
    if (request.method !== 'GET') throw new HttpError(405, 'GET required');
    const id = z.uuid().parse(request.url.slice('/get-status/'.length));
    return reply(response, await status(id));
  }
  throw new HttpError(404, 'route not found');
});
