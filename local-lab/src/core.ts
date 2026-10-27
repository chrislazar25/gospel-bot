import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { pool, HttpError } from './http.js';

const fields = z.object({ id: z.uuid(), channel: z.literal('simulator'), target: z.literal('synthetic-prayer-group'), date: z.string(), payload: z.string(), payload_hash: z.string(), attempts: z.number().int(), evidence: z.string() });
const rowSchema = z.union([
  fields.extend({ status: z.enum(['pending', 'unknown']), provider_id: z.null() }),
  fields.extend({ status: z.enum(['accepted', 'confirmed']), provider_id: z.uuid() }),
]);
export type Delivery = z.infer<typeof rowSchema>;
const providerReply = z.object({ providerId: z.uuid() }).strict();
const receipt = z.object({ providerId: z.uuid(), status: z.enum(['sent', 'delivered', 'read']) }).strict();
const rejection = z.object({ rejected: z.literal(true), code: z.literal('SIMULATED_REJECTION') }).strict();
const fakeUrl = z.literal('http://fake:3000').parse(process.env.FAKE_URL);
async function rows(sql: string, values: unknown[] = []) {
  const result = await pool.query<Record<string, unknown>>(sql, values);
  return result.rows.map(row => rowSchema.parse(row));
}
export async function get(id: string): Promise<Delivery> {
  const row = (await rows('SELECT * FROM deliveries WHERE id=$1', [id]))[0];
  if (!row) throw new HttpError(404, 'delivery not found');
  return row;
}
export async function status(id: string) {
  const row = await get(id);
  if (row.status !== 'accepted') return row;
  try {
    const response = await fetch(`${fakeUrl}/receipt/${row.provider_id}`, { signal: AbortSignal.timeout(1500) });
    const parsed = receipt.parse(await response.json());
    if (response.ok && parsed.providerId === row.provider_id && parsed.status !== 'sent') {
      await rows("UPDATE deliveries SET status='confirmed', evidence=$3 WHERE id=$1 AND attempts=$2 AND status='accepted' RETURNING *", [id, row.attempts, `receipt:${parsed.status}`]);
    }
  } catch (error: unknown) { process.stderr.write(JSON.stringify({ event: 'receipt_uncertain', deliveryId: id, error: String(error) }) + '\n'); }
  return get(id);
}
export async function sendToday() {
  const clock = z.object({ now: z.iso.datetime() }).strict().parse(JSON.parse(await readFile('/lab/config/clock.json', 'utf8')));
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock.now));
  let row = (await rows("SELECT * FROM deliveries WHERE channel='simulator' AND target='synthetic-prayer-group' AND date=$1", [date]))[0];
  if (!row) {
    const payload = await readFile(`/lab/content/${date}.txt`, 'utf8');
    await rows("INSERT INTO deliveries(id,channel,target,date,payload,payload_hash) VALUES($1,'simulator','synthetic-prayer-group',$2,$3,$4) ON CONFLICT(channel,target,date) DO NOTHING RETURNING *", [randomUUID(), date, payload, createHash('sha256').update(payload).digest('hex')]);
    row = (await rows("SELECT * FROM deliveries WHERE channel='simulator' AND target='synthetic-prayer-group' AND date=$1", [date]))[0];
  }
  if (!row) throw new Error('daily insert missing');
  const claimed = (await rows("UPDATE deliveries SET status='unknown', attempts=attempts+1, evidence='attempt committed before HTTP' WHERE id=$1 AND status='pending' RETURNING *", [row.id]))[0];
  if (!claimed) return get(row.id);
  try {
    const response = await fetch(`${fakeUrl}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: claimed.target, payload: claimed.payload }), signal: AbortSignal.timeout(1500) });
    const data: unknown = await response.json();
    if (response.status === 422 && rejection.safeParse(data).success) {
      await rows("UPDATE deliveries SET status='pending', evidence='simulator proved rejection' WHERE id=$1 AND attempts=$2 AND status='unknown' RETURNING *", [claimed.id, claimed.attempts]);
    } else if (response.ok) {
      const accepted = providerReply.parse(data);
      await rows("UPDATE deliveries SET status='accepted', provider_id=$3, evidence='simulator accepted; delivery unconfirmed' WHERE id=$1 AND attempts=$2 AND status='unknown' RETURNING *", [claimed.id, claimed.attempts, accepted.providerId]);
    }
  } catch (error: unknown) { process.stderr.write(JSON.stringify({ event: 'attempt_uncertain', deliveryId: claimed.id, error: String(error) }) + '\n'); }
  return get(row.id);
}
