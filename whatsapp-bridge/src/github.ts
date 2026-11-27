import { z } from 'zod';
import { type Issue, REPORT_LABEL } from './states.js';

const createdSchema = z.object({ number: z.number().int().positive() });
const listedSchema = z.array(z.object({
  number: z.number().int().positive(), body: z.string().nullish(), created_at: z.string(), pull_request: z.unknown().optional(),
}));
const PAGE = 100;
const issueSchema = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), state_reason: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
}).transform((i): Issue => ({
  number: i.number, state: i.state, stateReason: i.state_reason ?? null,
  labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
}));

export const MEDIA_BRANCH = 'benny-media';

export class GithubError extends Error {
  constructor(readonly status: number) { super(`github_${status}`); }
}

export type Github = {
  create(issue: { title: string; body: string; labels: string[] }): Promise<number>;
  get(number: number): Promise<Issue>;
  /** The report issue created at or after `since` whose body carries `marker`. */
  findByMarker(marker: string, since: Date): Promise<number | undefined>;
  upload(path: string, bytes: Buffer): Promise<string>;
  comment(issue: number, body: string): Promise<void>;
  addLabel(issue: number, label: string): Promise<void>;
};

export function createGithub(config: { token: string; repo: string }, request: typeof fetch = fetch): Github {
  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    const response = await request(`https://api.github.com/repos/${config.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'gospel-whatsapp-bridge',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(method === 'PUT' ? 60000 : 10000),
    });
    if (!response.ok) throw new GithubError(response.status);
    return response.json();
  }
  return {
    async create(issue) { return createdSchema.parse(await call('POST', '/issues', issue)).number; },
    async get(number) { return issueSchema.parse(await call('GET', `/issues/${number}`)); },
    async findByMarker(marker, since) {
      // `since` filters on updated_at, which an issue created since then also passes. Newest first, so stop at an older one.
      const query = `labels=${encodeURIComponent(REPORT_LABEL)}&state=all&sort=created&direction=desc&since=${encodeURIComponent(since.toISOString())}&per_page=${PAGE}`;
      for (let page = 1; ; page++) {
        const listed = listedSchema.parse(await call('GET', `/issues?${query}&page=${page}`));
        const fresh = listed.filter((i) => Date.parse(i.created_at) >= since.getTime());
        const found = fresh.find((i) => !i.pull_request && i.body?.includes(marker));
        if (found) return found.number;
        if (listed.length < PAGE || fresh.length < listed.length) return undefined;
      }
    },
    async comment(issue, body) { await call('POST', `/issues/${issue}/comments`, { body }); },
    async addLabel(issue, label) { await call('POST', `/issues/${issue}/labels`, { labels: [label] }); },
    async upload(path, bytes) {
      try { await call('PUT', `/contents/${path}`, { message: 'Add WhatsApp photo', content: bytes.toString('base64'), branch: MEDIA_BRANCH }); }
      catch (e) {
        // 422 usually means a crashed earlier attempt already uploaded it; confirm rather than assume.
        if (!(e instanceof GithubError && e.status === 422)) throw e;
        await call('GET', `/contents/${path}?ref=${MEDIA_BRANCH}`);
      }
      return `https://raw.githubusercontent.com/${config.repo}/${MEDIA_BRANCH}/${path}`;
    },
  };
}
