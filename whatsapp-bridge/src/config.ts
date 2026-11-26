import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const common = z.object({
  GITHUB_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('chrislazar25/gospel-bot'),
  BRIDGE_HOME: z.string().min(1).default(join(homedir(), '.gospel-bridge')),
  PAIR_PHONE: z.string().regex(/^\d+$/, 'digits only').optional(),
  POLL_SECONDS: z.coerce.number().int().min(5).default(60),
});
const run = common.extend({
  GITHUB_TOKEN: z.string().min(1),
  REPORT_GROUP_JID: z.string().regex(/^[\w-]+@g\.us$/),
});

const present = (env: Record<string, string | undefined>) => Object.fromEntries(Object.entries(env).filter(([, v]) => v));

export const linkConfig = (env: Record<string, string | undefined>) => common.parse(present(env));
export const runConfig = (env: Record<string, string | undefined>) => run.parse(present(env));
