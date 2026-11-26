import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = {
  'GitHub token': /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/,
  'Anthropic key or Claude token': /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  'AWS access key': /\bAKIA[0-9A-Z]{16}\b/,
  'Slack token': /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  'Private key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  'Google API key': /\bAIza[0-9A-Za-z_-]{35}\b/,
};
const forbiddenPaths = /(^|\/)(creds\.json|pre-key-[^/]*\.json|session-[^/]*\.json|app-state-sync-[^/]*\.json|\.env(\.[^/]*)?)$/;

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  if (forbiddenPaths.test(file)) findings.push(`${file}: credential file is tracked`);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  for (const [name, re] of Object.entries(patterns)) if (re.test(text)) findings.push(`${file}: looks like a ${name}`);
}
if (findings.length) {
  console.error(findings.join('\n'));
  process.exit(1);
}
console.log(`no secrets in ${files.length} tracked files`);
