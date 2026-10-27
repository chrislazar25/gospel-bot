import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { serve, body, reply, pool, HttpError } from './http.js';

const mode = z.enum(['success', 'reject', 'generic500', 'accept-drop', 'delayed', 'timeout', 'malformed']);

serve(async (request, response) => {
  if (request.url === '/health' && request.method === 'GET') {
    await pool.query('SELECT 1 FROM simulator.control');
    return reply(response, { ok: true, kind: 'simulator contract; not verified GreenAPI' });
  }
  if (request.url === '/send' && request.method === 'POST') {
    const data = z.object({ target: z.literal('synthetic-prayer-group'), payload: z.string().min(1) }).strict().parse(await body(request));
    const control = await pool.query<Record<string, unknown>>('SELECT mode FROM simulator.control');
    const selected = mode.parse(control.rows[0]?.mode);
    const providerId = randomUUID();
    await pool.query('INSERT INTO simulator.requests(id,target,payload,accepted) VALUES($1,$2,$3,$4)', [providerId, data.target, data.payload, selected !== 'reject' && selected !== 'generic500']);
    if (selected === 'reject') return reply(response, { rejected: true, code: 'SIMULATED_REJECTION' }, 422);
    if (selected === 'generic500') return reply(response, { error: 'unproven generic failure' }, 500);
    if (selected === 'accept-drop') { response.destroy(); return; }
    if (selected === 'timeout') await new Promise(resolve => setTimeout(resolve, 2500));
    if (selected === 'malformed') return reply(response, { accepted: true });
    return reply(response, { providerId });
  }
  if (request.url?.startsWith('/receipt/') && request.method === 'GET') {
    const providerId = z.uuid().parse(request.url.slice('/receipt/'.length));
    const result = await pool.query<Record<string, unknown>>('SELECT receipt FROM simulator.requests WHERE id=$1 AND accepted=true', [providerId]);
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'receipt missing');
    return reply(response, { providerId, status: z.enum(['sent','delivered','read']).parse(row.receipt) });
  }
  if (request.url === '/admin/control' && request.method === 'POST') {
    const data = z.object({ mode }).strict().parse(await body(request));
    await pool.query('UPDATE simulator.control SET mode=$1', [data.mode]);
    return reply(response, data);
  }
  if (request.url === '/admin/confirm' && request.method === 'POST') {
    const data = z.object({ providerId: z.uuid() }).strict().parse(await body(request));
    const result = await pool.query("UPDATE simulator.requests SET receipt='delivered' WHERE id=$1 AND accepted=true", [data.providerId]);
    if (result.rowCount !== 1) throw new HttpError(404, 'accepted request missing');
    return reply(response, { ok: true });
  }
  if (request.url === '/admin/requests' && request.method === 'GET') {
    const result = await pool.query<Record<string, unknown>>('SELECT * FROM simulator.requests ORDER BY id');
    return reply(response, result.rows);
  }
  throw new HttpError(404, 'route not found');
});
