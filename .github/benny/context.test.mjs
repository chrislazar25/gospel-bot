import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('context.sh', import.meta.url));

test('triage uses human evidence while fix retains earlier Benny notes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'benny-context-test-'));
  const photo = name => `https://raw.githubusercontent.com/example/gospel/benny-media/reports/${name}.jpg`;
  const comment = (login, body) => ({ user: { login }, body, created_at: '2026-11-27T19:20:00Z' });
  const issue = {
    number: 40, title: 'Proposed December message', body: `This should be Dec 5th message. ${photo('report')}`,
    created_at: '2026-11-27T19:15:00Z', labels: [],
  };
  const notes = [
    comment('github-actions[bot]', `<!-- benny:triage --> Mistaken November 28 delivery claim. ${photo('bot')}`),
    comment('chrislazar25', `Clarification from the owner. ${photo('followup')}`),
    comment('outsider', `Untrusted outsider detail. ${photo('outsider')}`),
    comment('github-actions[bot]', `Unrelated automation. ${photo('automation')}`),
  ];
  try {
    writeFileSync(join(directory, 'issue.json'), JSON.stringify(issue));
    writeFileSync(join(directory, 'comments.json'), JSON.stringify(notes));
    writeFileSync(join(directory, 'open.json'), '[]');
    writeFileSync(join(directory, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const endpoint = process.argv.at(-1);
const fixture = endpoint.includes('/comments?') ? 'comments.json' : endpoint.includes('/issues?') ? 'open.json' : 'issue.json';
process.stdout.write(fs.readFileSync(path.join(process.env.FIXTURES, fixture)));
`, { mode: 0o755 });
    writeFileSync(join(directory, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOWNLOADS, args.at(-1) + '\\n');
fs.writeFileSync(args[args.indexOf('-o') + 1], 'photo');
`, { mode: 0o755 });

    for (const stage of [undefined, 'triage', 'fix']) {
      const output = join(directory, stage ?? 'default');
      const downloads = join(directory, 'downloads');
      writeFileSync(downloads, '');
      const args = [script, '40', output];
      if (stage) args.push(stage);
      const result = spawnSync('bash', args, {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURES: directory, DOWNLOADS: downloads, GITHUB_REPOSITORY: 'example/gospel' },
      });
      assert.equal(result.status, 0, result.stderr);
      const report = readFileSync(join(output, 'report.md'), 'utf8');
      assert.match(report, /This should be Dec 5th message/);
      assert.match(report, /Opened: 2026-11-28 00:45 IST/);
      assert.match(report, /Clarification from the owner/);
      assert.doesNotMatch(report, /Untrusted outsider detail|Unrelated automation/);
      assert.equal(report.includes('Mistaken November 28 delivery claim'), stage === 'fix');
      assert.deepEqual(JSON.parse(readFileSync(join(output, 'notes.json'), 'utf8')).map(note => note.user.login),
        stage === 'fix' ? ['github-actions[bot]', 'chrislazar25'] : ['chrislazar25']);
      assert.deepEqual(readFileSync(downloads, 'utf8').trim().split('\n').sort(),
        (stage === 'fix' ? [photo('report'), photo('followup'), photo('bot')] : [photo('report'), photo('followup')]).sort());
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
