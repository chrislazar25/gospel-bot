import { randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';

const fields = z.object({ id: z.uuid(), channel: z.string(), target: z.string(), date: z.string(), payload: z.string(), payload_hash: z.string(), attempts: z.number().int(), evidence: z.string() });
export const deliverySchema = z.union([
  fields.extend({ status: z.enum(['pending', 'unknown']), provider_id: z.null() }),
  fields.extend({ status: z.enum(['accepted', 'confirmed', 'failed']), provider_id: z.string().min(1) }),
]);
export type Delivery = z.infer<typeof deliverySchema>;
export type SendOutcome = { kind: 'accepted'; providerId: string } | { kind: 'rejected' } | { kind: 'unknown' };
export type ReceiptOutcome = { kind: 'receipt'; providerId: string; status: 'sent' | 'delivered' | 'read' | 'failed' } | { kind: 'unavailable' };
export type Provider = {
  send(delivery: Delivery): Promise<SendOutcome>;
  receipt(delivery: Delivery): Promise<ReceiptOutcome>;
};
export type SendPolicy = { kind: 'lab' } | { kind: 'scheduled'; enabled: boolean; firstDate: string | undefined; startMinute: number; endMinute: number };
export class DeliveryError extends Error {
  constructor(readonly code: 'not_found' | 'sending_held' | 'date_ineligible' | 'outside_window') { super(code); }
}
export function istDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function checkSendPolicy(policy: SendPolicy, now: Date) {
  if (policy.kind === 'lab') return;
  if (!policy.enabled) throw new DeliveryError('sending_held');
  if (!policy.firstDate || istDate(now) < policy.firstDate) throw new DeliveryError('date_ineligible');
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minute = Number(parts.find(part => part.type === 'hour')?.value) * 60 + Number(parts.find(part => part.type === 'minute')?.value);
  if (minute < policy.startMinute || minute >= policy.endMinute) throw new DeliveryError('outside_window');
}
export function createDeliveryService(options: {
  db: Pool; channel: string; target: string; now(): Promise<Date>; message(date: string): Promise<string>; provider: Provider; policy: SendPolicy; revision?: string;
}) {
  const { db, channel, target, provider } = options;
  async function rows(sql: string, values: unknown[] = []) {
    const result = await db.query<Record<string, unknown>>(sql, values);
    return result.rows.map(row => deliverySchema.parse(row));
  }
  async function get(id: string): Promise<Delivery> {
    const row = (await rows('SELECT * FROM deliveries WHERE id=$1 AND channel=$2 AND target=$3', [id, channel, target]))[0];
    if (!row) throw new DeliveryError('not_found');
    return row;
  }
  async function reconcile(id: string) {
    const row = await get(id);
    if (row.status !== 'accepted') return row;
    const checking = (await rows("UPDATE deliveries SET evidence='receipt check started' WHERE id=$1 AND attempts=$2 AND status='accepted' RETURNING *", [id, row.attempts]))[0];
    if (!checking) return get(id);
    try {
      const receipt = await provider.receipt(checking);
      if (receipt.kind === 'receipt' && receipt.providerId === row.provider_id && receipt.status !== 'sent') {
        const status = receipt.status === 'failed' ? 'failed' : 'confirmed';
        await rows("UPDATE deliveries SET status=$3, evidence=$4 WHERE id=$1 AND attempts=$2 AND status='accepted' RETURNING *", [id, row.attempts, status, `receipt:${receipt.status}`]);
      }
    } catch { process.stderr.write(JSON.stringify({ event: 'receipt_uncertain', deliveryId: id }) + '\n'); }
    return get(id);
  }
  async function reconcileAccepted(limit = 50) {
    const accepted = await rows(`SELECT d.* FROM deliveries d
      LEFT JOIN (SELECT delivery_id,max(recorded_at) AS last_activity FROM delivery_evidence GROUP BY delivery_id) e ON e.delivery_id=d.id
      WHERE d.channel=$1 AND d.target=$2 AND d.status='accepted'
      ORDER BY e.last_activity NULLS FIRST,d.date,d.id LIMIT $3`, [channel, target, limit]);
    const results: Delivery[] = [];
    for (const row of accepted) results.push(await reconcile(row.id));
    return results;
  }
  async function sendToday() {
    const now = await options.now();
    checkSendPolicy(options.policy, now);
    const date = istDate(now);
    let row = (await rows('SELECT * FROM deliveries WHERE channel=$1 AND target=$2 AND date=$3', [channel, target, date]))[0];
    if (!row) {
      const payload = await options.message(date);
      await rows("INSERT INTO deliveries(id,channel,target,date,payload,payload_hash,evidence) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(channel,target,date) DO NOTHING RETURNING *", [randomUUID(), channel, target, date, payload, createHash('sha256').update(payload).digest('hex'), `created:${options.revision ?? 'local-lab'}`]);
      row = (await rows('SELECT * FROM deliveries WHERE channel=$1 AND target=$2 AND date=$3', [channel, target, date]))[0];
    }
    if (!row) throw new Error('daily insert missing');
    checkSendPolicy(options.policy, await options.now());
    const claimed = (await rows("UPDATE deliveries SET status='unknown', attempts=attempts+1, evidence='attempt committed before HTTP' WHERE id=$1 AND status='pending' RETURNING *", [row.id]))[0];
    if (!claimed) return get(row.id);
    try {
      const result = await provider.send(claimed);
      if (result.kind === 'rejected') {
        await rows("UPDATE deliveries SET status='pending', evidence='simulator proved rejection' WHERE id=$1 AND attempts=$2 AND status='unknown' RETURNING *", [claimed.id, claimed.attempts]);
      } else if (result.kind === 'accepted') {
        await rows("UPDATE deliveries SET status='accepted', provider_id=$3, evidence='provider accepted; delivery unconfirmed' WHERE id=$1 AND attempts=$2 AND status='unknown' RETURNING *", [claimed.id, claimed.attempts, result.providerId]);
      }
    } catch { process.stderr.write(JSON.stringify({ event: 'attempt_uncertain', deliveryId: claimed.id }) + '\n'); }
    return get(row.id);
  }
  return { get, sendToday, reconcile, reconcileAccepted };
}
