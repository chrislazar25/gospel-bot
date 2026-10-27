import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./', import.meta.url));
const project = `gospel-runtime-${randomUUID().slice(0, 8)}`;
const evidence = new URL(`evidence/${project}/`, import.meta.url);
mkdirSync(evidence, { recursive: true });
const args = ['compose', '-p', project, '-f', root + 'runtime-test/compose.yaml'];
const compose = flags => execFileSync('docker', [...args, ...flags], { encoding: 'utf8', maxBuffer: 10000000 });
try {
  process.stdout.write(compose(['build', 'verify']));
  process.stdout.write(compose(['up', '-d', '--wait', 'db']));
  const output = compose(['run', '--rm', '--no-deps', 'verify']);
  writeFileSync(new URL('tests.tap', evidence), output);
  process.stdout.write(output);
} catch (error) {
  writeFileSync(new URL('failure.txt', evidence), String(error.stdout ?? '') + String(error.stderr ?? ''));
  throw error;
} finally {
  try { writeFileSync(new URL('compose.log', evidence), compose(['logs', '--no-color'])); }
  finally { process.stdout.write(compose(['down', '--volumes', '--remove-orphans'])); }
}
