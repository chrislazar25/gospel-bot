import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseConfig, createNeonApi, runNeon, createSecretStore, connectOwner, safeError } from './neon-operation.mjs';

export async function main(env = process.env, argv = process.argv.slice(2)) {
  try {
    const config = parseConfig(env, argv);
    const report = await runNeon(config, {
      neon: createNeonApi(config.apiKey),
      provisioning: async () => {
        const require = createRequire(new URL('../../local-lab/package.json', import.meta.url));
        const { Client } = require('pg');
        return { secrets: createSecretStore(config.secrets, spawnSync), connect: uri => connectOwner(uri, Client) };
      },
    });
    console.log(JSON.stringify(report));
    return 0;
  } catch (error) {
    console.error(`Neon operation failed: ${safeError(error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
