import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { pool, HttpError } from './http.js';
import { createDeliveryService, DeliveryError, type Provider } from './delivery.js';

const fakeUrl = z.literal('http://fake:3000').parse(process.env.FAKE_URL);
const provider: Provider = {
  async send(delivery) {
    const response = await fetch(`${fakeUrl}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: delivery.target, payload: delivery.payload }), signal: AbortSignal.timeout(1500) });
    const data: unknown = await response.json();
    if (response.status === 422 && z.object({ rejected: z.literal(true), code: z.literal('SIMULATED_REJECTION') }).strict().safeParse(data).success) return { kind: 'rejected' };
    if (!response.ok) return { kind: 'unknown' };
    return { kind: 'accepted', providerId: z.object({ providerId: z.uuid() }).strict().parse(data).providerId };
  },
  async receipt(delivery) {
    const response = await fetch(`${fakeUrl}/receipt/${delivery.provider_id}`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { kind: 'unavailable' };
    const parsed = z.object({ providerId: z.uuid(), status: z.enum(['sent', 'delivered', 'read']) }).strict().parse(await response.json());
    return { kind: 'receipt', ...parsed };
  },
};
const service = createDeliveryService({
  db: pool, channel: 'simulator', target: 'synthetic-prayer-group', provider, policy: { kind: 'lab' },
  async now() {
    const clock = z.object({ now: z.iso.datetime() }).strict().parse(JSON.parse(await readFile('/lab/config/clock.json', 'utf8')));
    return new Date(clock.now);
  },
  message: date => readFile(`/lab/content/${date}.txt`, 'utf8'),
});
export const sendToday = service.sendToday;
export async function status(id: string) {
  try { return await service.reconcile(id); }
  catch (error) { if (error instanceof DeliveryError && error.code === 'not_found') throw new HttpError(404, 'delivery not found'); throw error; }
}
