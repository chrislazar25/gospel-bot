import { z } from 'zod';
import type { Provider } from './delivery.js';

const acceptedSchema = z.object({ idMessage: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) });
const receiptSchema = z.object({
  type: z.literal('outgoing'), idMessage: z.string().min(1), chatId: z.string().min(1),
  statusMessage: z.enum(['pending', 'sent', 'yellowCard', 'delivered', 'read', 'failed']),
});
export const greenConfigSchema = z.object({
  url: z.url().regex(/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)?api\.green-?api\.com\/?$/, 'Use the assigned Green API HTTPS origin'),
  instanceId: z.string().regex(/^\d+$/), token: z.string().regex(/^[A-Za-z0-9_-]+$/),
});
export function createGreenApi(config: z.infer<typeof greenConfigSchema>, request: typeof fetch = fetch): Provider {
  async function call(method: string, body?: unknown): Promise<unknown> {
    const url = `${config.url.replace(/\/$/, '')}/waInstance${config.instanceId}/${method}/${config.token}`;
    const response = await request(url, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('provider_request_failed');
    return response.json();
  }
  return {
    async send(delivery) {
      try {
        const state = z.object({ stateInstance: z.literal('authorized') }).safeParse(await call('getStateInstance'));
        if (!state.success) return { kind: 'unknown' };
        const accepted = acceptedSchema.parse(await call('sendMessage', { chatId: delivery.target, message: delivery.payload }));
        return { kind: 'accepted', providerId: accepted.idMessage };
      } catch { return { kind: 'unknown' }; }
    },
    async receipt(delivery) {
      if (!delivery.provider_id) return { kind: 'unavailable' };
      try {
        const parsed = receiptSchema.parse(await call('getMessage', { chatId: delivery.target, idMessage: delivery.provider_id }));
        if (parsed.idMessage !== delivery.provider_id || parsed.chatId !== delivery.target) return { kind: 'unavailable' };
        if (parsed.statusMessage === 'pending' || parsed.statusMessage === 'yellowCard') return { kind: 'unavailable' };
        return { kind: 'receipt', providerId: parsed.idMessage, status: parsed.statusMessage };
      } catch { return { kind: 'unavailable' }; }
    },
  };
}
