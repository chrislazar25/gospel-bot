import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { reconcileRole } from './neon-role.mjs';
const require = createRequire(new URL('../../local-lab/package.json', import.meta.url));
const { Client } = require('pg');
const env = process.env;
for (const key of ['NEON_API_KEY', 'NEON_ORG_ID', 'GCP_PROJECT_ID', 'APP_ENV']) {
  if (!env[key]) throw new Error(`Missing ${key}`);
}
if (!['staging', 'production'].includes(env.APP_ENV)) throw new Error('Invalid APP_ENV');
const prefix = `gospel-${env.APP_ENV}`;
const api = async (path, body) => {
  const response = await fetch(`https://console.neon.tech/api/v2/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${env.NEON_API_KEY}`, 'Content-Type': 'application/json' },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Neon API failed with HTTP ${response.status}`);
  return response.json();
};
const secret = (name, value) => {
  const args = value === undefined
    ? ['secrets', 'versions', 'access', 'latest', `--secret=${prefix}-${name}`]
    : ['secrets', 'versions', 'add', `${prefix}-${name}`, '--data-file=-'];
  const result = spawnSync('gcloud', [...args, `--project=${env.GCP_PROJECT_ID}`, '--quiet'], {
    input: value, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    if (value === undefined && /NOT_FOUND/.test(result.stderr)) return undefined;
    throw new Error(`Secret Manager operation failed for ${name}`);
  }
  return value === undefined ? result.stdout.trim() : value;
};
let client;
try {
  const projects = [];
  let cursor = '';
  do {
    const page = await api(`projects?org_id=${encodeURIComponent(env.NEON_ORG_ID)}&limit=400${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (page.unavailable_project_ids?.length) throw new Error('Project listing is incomplete');
    projects.push(...page.projects);
    cursor = page.pagination?.cursor ?? '';
  } while (cursor);
  const matches = projects.filter(project => project.name === prefix);
  if (matches.length > 1) throw new Error('Duplicate Neon project names require manual review');
  let project = matches[0];
  if (!project) {
    const created = await api('projects', { project: {
      name: prefix, org_id: env.NEON_ORG_ID, region_id: env.NEON_REGION ?? 'aws-us-east-2',
      pg_version: 17, store_passwords: true, branch: { name: 'main', database_name: 'gospel', role_name: 'gospel_owner' },
    } });
    project = created.project;
  }
  const params = new URLSearchParams({ database_name: 'gospel', role_name: 'gospel_owner', pooled: 'false' });
  const { uri } = await api(`projects/${project.id}/connection_uri?${params}`);
  const previousOwner = secret('migration-database');
  const owner = previousOwner === uri ? previousOwner : secret('migration-database', uri);
  client = new Client({ connectionString: owner, connectionTimeoutMillis: 30000 });
  for (let attempt = 0; ; attempt++) {
    try { await client.connect(); break; }
    catch {
      if (attempt >= 11) throw new Error('Neon database did not become ready');
      await new Promise(resolve => setTimeout(resolve, 5000));
      client = new Client({ connectionString: owner, connectionTimeoutMillis: 30000 });
    }
  }
  for (const [name, role] of [
    ['database', 'gospel_runtime'],
    ['status-database', 'gospel_status'],
  ]) {
    let connection = secret(name);
    if (!connection) {
      const password = randomBytes(32).toString('base64url');
      const url = new URL(owner);
      url.username = role;
      url.password = password;
      connection = url.toString();
      // Persist the chosen password before SQL so interrupted runs can recover it.
      secret(name, connection);
    }
    const existingUrl = new URL(connection);
    const ownerUrl = new URL(owner);
    if (existingUrl.hostname !== ownerUrl.hostname || existingUrl.pathname !== ownerUrl.pathname || existingUrl.username !== role) {
      throw new Error('Stored role URL does not match the selected Neon database');
    }
    const password = decodeURIComponent(existingUrl.password);
    await reconcileRole(client, {
      role, password, database: 'gospel', owner: 'gospel_owner', readOnly: name === 'status-database',
    });
  }
  console.log(`Neon ${env.APP_ENV} database secrets reconciled. No schema migrations ran.`);
} catch {
  console.error('Neon provisioning failed. Inspect account permissions and project state without printing connection strings.');
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
