import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createPool } from './db.js';
import { createDeliveryService, DeliveryError, istDate } from './delivery.js';
import { createGreenApi, greenConfigSchema } from './green-api.js';
import { loadContent, dateSchema, ContentError } from './content.js';
import { migrate, checkSchema } from './migrate.js';
import { createStatusServer, readStatus } from './status.js';

export const commands = z.enum(['service', 'send', 'reconcile', 'check', 'migrate', 'content-check']);
const booleanFlag = z.enum(['true', 'false']).default('false').transform(value => value === 'true');
export const baseConfigSchema = z.object({
  APP_ENV: z.enum(['staging', 'production']),
  CONTENT_DIR: z.string().default('/app/content'),
  RELEASE_SHA: z.string().regex(/^(unreleased|[a-f0-9]{40})$/).default('unreleased'),
});
export const policySchema = z.object({
  SENDING_ENABLED: booleanFlag,
  FIRST_SEND_DATE: dateSchema.optional(),
  SEND_WINDOW_START_MINUTE: z.coerce.number().int().min(0).max(1439).default(420),
  SEND_WINDOW_END_MINUTE: z.coerce.number().int().min(1).max(1440).default(480),
  DELIVERY_DEADLINE_MINUTE: z.coerce.number().int().min(0).max(1439).default(450),
}).refine(value => value.SEND_WINDOW_START_MINUTE < value.SEND_WINDOW_END_MINUTE, 'Invalid send window');
function emit(event: string, fields: Record<string, unknown> = {}, severity = 'INFO') {
  process.stdout.write(JSON.stringify({ severity, event, ...fields }) + '\n');
}
function databaseUrl(env: NodeJS.ProcessEnv) {
  return z.url().refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)).parse(env.DATABASE_URL);
}
export async function main(argv: string[], env: NodeJS.ProcessEnv) {
  const command = commands.parse(argv[0] ?? 'check');
  if (argv.length > 1) throw new Error('unexpected_arguments');
  const config = baseConfigSchema.parse(env);
  const date = istDate(new Date());
  if (command === 'content-check') {
    const content = await loadContent(config.CONTENT_DIR);
    content.requireCoverage(date);
    emit('content_valid', { date, contentDaysRemaining: content.daysRemaining(date), revision: config.RELEASE_SHA });
    return;
  }
  const db = createPool(databaseUrl(env), true);
  let ownsServer = false;
  try {
    if (command === 'migrate') {
      await migrate(db);
      emit('migration_complete', { revision: config.RELEASE_SHA });
      return;
    }
    if (command === 'service') {
      const port = z.coerce.number().int().min(1).max(65535).default(8080).parse(env.PORT);
      const server = createStatusServer(db, config.RELEASE_SHA);
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
      ownsServer = true;
      const stop = () => { server.close(() => { void db.end(); }); };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      emit('status_service_ready', { port, revision: config.RELEASE_SHA });
      return;
    }
    await checkSchema(db);
    const policy = policySchema.parse(env);
    if (command === 'send' && !policy.SENDING_ENABLED) {
      emit('sending_held', { date });
      return;
    }
    const content = await loadContent(config.CONTENT_DIR);
    if (command === 'check') {
      const deliveries = await readStatus(db, date);
      const remaining = content.daysRemaining(date);
      const status = deliveries[0]?.status ?? (policy.SENDING_ENABLED ? 'missing' : 'held');
      emit('delivery_check', { date, status, enabled: policy.SENDING_ENABLED, contentDaysRemaining: remaining, revision: config.RELEASE_SHA });
      if (remaining < 7) emit('content_warning', { date, contentDaysRemaining: remaining }, 'WARNING');
      const ist = new Date(Date.now() + 330 * 60000);
      const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      if (deliveries.some(row => row.status === 'unknown' || row.status === 'failed') || (policy.SENDING_ENABLED && minute >= policy.DELIVERY_DEADLINE_MINUTE && status !== 'confirmed')) {
        emit('delivery_problem', { date, status }, 'ERROR');
        throw new Error('delivery_requires_attention');
      }
      return;
    }
    const green = greenConfigSchema.parse({ url: env.GREEN_API_URL, instanceId: env.GREEN_API_ID, token: env.GREEN_API_TOKEN });
    const target = z.string().regex(/^\d+(?:-\d+)?@g\.us$/).parse(env.TARGET_CHAT_ID);
    const service = createDeliveryService({ db, channel: 'green-api', target, now: async () => new Date(), message: content.message, provider: createGreenApi(green), revision: config.RELEASE_SHA,
      policy: { kind: 'scheduled', enabled: policy.SENDING_ENABLED, firstDate: policy.FIRST_SEND_DATE, startMinute: policy.SEND_WINDOW_START_MINUTE, endMinute: policy.SEND_WINDOW_END_MINUTE } });
    if (command === 'send') {
      const delivery = await service.sendToday();
      emit('delivery_attempt', { deliveryId: delivery.id, date: delivery.date, status: delivery.status, revision: config.RELEASE_SHA });
      if (delivery.status === 'unknown' || delivery.status === 'failed') {
        emit('delivery_problem', { date, status: delivery.status, deliveryId: delivery.id }, 'ERROR');
        throw new Error('delivery_requires_attention');
      }
    } else {
      const deliveries = await service.reconcileAccepted();
      emit('reconciliation_complete', { checked: deliveries.length, confirmed: deliveries.filter(row => row.status === 'confirmed').length });
      for (const row of deliveries.filter(row => row.status === 'failed')) emit('delivery_problem', { deliveryId: row.id, status: row.status }, 'ERROR');
    }
  } finally { if (!ownsServer) await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).catch(error => {
    if (error instanceof DeliveryError && error.code !== 'not_found') {
      emit('sending_held', { reason: error.code });
    } else {
      emit('runtime_failed', { reason: error instanceof ContentError ? error.code : error instanceof z.ZodError ? 'configuration_invalid' : 'operation_failed' }, 'ERROR');
      process.exitCode = 1;
    }
  });
}
