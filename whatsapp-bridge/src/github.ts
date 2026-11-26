import { z } from 'zod';
import type { Issue } from './states.js';

const createdSchema = z.object({ number: z.number().int().positive() });
const issueSchema = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), state_reason: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
}).transform((i): Issue => ({
  number: i.number, state: i.state, stateReason: i.state_reason ?? null,
  labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
}));

export type Github = {
  create(issue: { title: string; body: string; labels: string[] }): Promise<number>;
  get(number: number): Promise<Issue>;
};

export function createGithub(config: { token: string; repo: string }, request: typeof fetch = fetch): Github {
  async function call(path: string, body?: unknown): Promise<unknown> {
    const response = await request(`https://api.github.com/repos/${config.repo}/issues${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${config.token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'gospel-whatsapp-bridge',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`github_${response.status}`);
    return response.json();
  }
  return {
    async create(issue) { return createdSchema.parse(await call('', issue)).number; },
    async get(number) { return issueSchema.parse(await call(`/${number}`)); },
  };
}
