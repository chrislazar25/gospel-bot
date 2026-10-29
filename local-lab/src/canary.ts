import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPool } from './db.js';
import { createDeliveryService, deliverySchema, type Delivery } from './delivery.js';
import { createGreenApi, greenConfigSchema } from './green-api.js';
import { checkSchema } from './migrate.js';
import { createStatusServer } from './status.js';

export const CANARY_CONFIRMATION = 'send-one-marked-private-staging-test';
export const CANARY_PAYLOAD = 'Gospel Bot staging test. This is a single test message. Daily Gospel delivery remains disabled.';
export const CANARY_HASH = createHash('sha256').update(CANARY_PAYLOAD).digest('hex');
export const CANARY_DATE = '1970-01-01';
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const databaseSchema = z.url().refine(value => {
  const url = new URL(value);
  return ['postgres:', 'postgresql:'].includes(url.protocol) && !!url.hostname && !!url.password && url.pathname.length > 1 && !url.hash;
});
export const canaryConfigSchema = z.object({
  APP_ENV: z.literal('staging'),
  CANARY_CONFIRMATION: z.literal(CANARY_CONFIRMATION),
  CANARY_TARGET_CHAT_ID: z.string().regex(/^\d{7,15}@c\.us$/),
  RELEASE_SHA: revisionSchema,
  CANARY_EXPECTED_REVISION: revisionSchema,
  DATABASE_URL: databaseSchema.refine(value => new URL(value).username === 'gospel_runtime'),
  STATUS_DATABASE_URL: databaseSchema.refine(value => new URL(value).username === 'gospel_status'),
  GREEN_API_URL: greenConfigSchema.shape.url,
  GREEN_API_ID: greenConfigSchema.shape.instanceId,
  GREEN_API_TOKEN: greenConfigSchema.shape.token,
}).refine(value => value.RELEASE_SHA === value.CANARY_EXPECTED_REVISION, 'revision_mismatch')
  .refine(value => {
    const runtime = new URL(value.DATABASE_URL);
    const status = new URL(value.STATUS_DATABASE_URL);
    return runtime.host === status.host && runtime.pathname === status.pathname;
  }, 'database_target_mismatch');
export type CanaryConfig = z.infer<typeof canaryConfigSchema>;
const statusSchema = z.object({ id: z.uuid(), date: z.literal(CANARY_DATE), status: deliverySchema.options[0].shape.status.or(deliverySchema.options[1].shape.status), attempts: z.literal(1), payloadHash: z.literal(CANARY_HASH) });
export type CanaryEvidence = {
  event: 'canary_verified' | 'canary_requires_attention';
  revision: string;
  deliveryId: string;
  status: Delivery['status'];
  attempts: number;
  payloadHash: string;
  priorConfirmation: boolean;
  statusHttp: 'loopback-verified';
};
function assertPayload(row: Delivery, config: CanaryConfig) {
  if (row.channel !== 'green-api' || row.target !== config.CANARY_TARGET_CHAT_ID || row.date !== CANARY_DATE || row.payload !== CANARY_PAYLOAD || row.payload_hash !== CANARY_HASH) throw new Error('canary_payload_mismatch');
}
export async function runCanary(config: CanaryConfig, options: { request?: typeof fetch; pool?: typeof createPool; receiptChecks?: number; pause?: () => Promise<void> } = {}): Promise<CanaryEvidence> {
  const openPool = options.pool ?? createPool;
  const db = openPool(config.DATABASE_URL, true);
  const statusDb = openPool(config.STATUS_DATABASE_URL, true);
  const status = createStatusServer(statusDb, config.RELEASE_SHA);
  const provider = createGreenApi({ url: config.GREEN_API_URL, instanceId: config.GREEN_API_ID, token: config.GREEN_API_TOKEN }, options.request);
  try {
    await checkSchema(db);
    await checkSchema(statusDb);
    const existing = await db.query<Record<string, unknown>>("SELECT * FROM deliveries WHERE channel='green-api' AND target=$1 AND date=$2", [config.CANARY_TARGET_CHAT_ID, CANARY_DATE]);
    const previous = existing.rows[0] ? deliverySchema.parse(existing.rows[0]) : undefined;
    if (previous) assertPayload(previous, config);
    const service = createDeliveryService({ db, channel: 'green-api', target: config.CANARY_TARGET_CHAT_ID, now: async () => new Date('1970-01-01T00:00:00Z'), message: async () => CANARY_PAYLOAD, policy: { kind: 'lab' }, revision: config.RELEASE_SHA,
      provider: { send: async row => { assertPayload(row, config); return provider.send(row); }, receipt: row => { assertPayload(row, config); return provider.receipt(row); } } });
    let row = await service.sendToday();
    assertPayload(row, config);
    for (let attempt = 0; row.status === 'accepted' && attempt < (options.receiptChecks ?? 12); attempt++) {
      if (attempt > 0) await (options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 5000))))();
      row = await service.reconcile(row.id);
    }
    await new Promise<void>((resolve, reject) => { status.once('error', reject); status.listen(0, '127.0.0.1', resolve); });
    const address = status.address();
    if (!address || typeof address === 'string') throw new Error('canary_status_unavailable');
    const origin = `http://127.0.0.1:${address.port}`;
    const health = await fetch(origin + '/health', { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw new Error('canary_status_unavailable');
    z.object({ ok: z.literal(true), revision: z.literal(config.RELEASE_SHA) }).parse(await health.json());
    const response = await fetch(origin + '/get-status/' + row.id, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('canary_status_unavailable');
    const observed = statusSchema.parse(await response.json());
    if (observed.id !== row.id || observed.attempts !== row.attempts) throw new Error('canary_status_mismatch');
    return { event: observed.status === 'confirmed' ? 'canary_verified' : 'canary_requires_attention', revision: config.RELEASE_SHA, deliveryId: row.id, status: observed.status, attempts: observed.attempts, payloadHash: CANARY_HASH, priorConfirmation: previous?.status === 'confirmed', statusHttp: 'loopback-verified' };
  } finally {
    status.closeAllConnections();
    if (status.listening) await new Promise<void>((resolve, reject) => status.close(error => error ? reject(error) : resolve()));
    await Promise.all([db.end(), statusDb.end()]);
  }
}
export async function main(argv: string[], env: NodeJS.ProcessEnv) {
  if (argv.length) throw new Error('unexpected_arguments');
  const config = canaryConfigSchema.parse(env);
  const evidence = await runCanary(config);
  process.stdout.write(JSON.stringify(evidence) + '\n');
  if (evidence.event !== 'canary_verified') process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch(error => {
    process.stdout.write(JSON.stringify({ event: 'canary_failed', reason: error instanceof z.ZodError ? 'configuration_invalid' : 'operation_failed' }) + '\n');
    process.exitCode = 1;
  });
}
