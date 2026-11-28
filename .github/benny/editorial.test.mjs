import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('check-editorial-patch.sh', import.meta.url));

test('editorial drafts require one modified existing future message', t => {
  const repo = mkdtempSync(join(tmpdir(), 'benny-editorial-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const run = (cmd, ...args) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  const git = (...args) => {
    const result = run('git', ...args);
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (path, text = 'changed') => writeFileSync(join(repo, path), text);
  const future = 'content/messages/2999-12-05.txt';
  const past = 'content/messages/2000-01-01.txt';

  mkdirSync(join(repo, 'content/messages'), { recursive: true });
  git('init', '-q');
  for (const path of [future, past, 'README.md']) write(path, 'original');
  git('add', '-A');
  git('-c', 'user.name=Benny', '-c', 'user.email=benny@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');

  const check = (accepted, ...paths) => {
    git('reset', '--hard', '-q', 'HEAD');
    for (const path of paths) write(path);
    git('add', '-A');
    const result = run('bash', guard);
    assert.equal(result.status, accepted ? 0 : 1, `Patch for ${paths}: ${result.stderr}`);
  };

  check(true, future);
  check(false, future, 'README.md');
  check(false, past);
  check(false, 'content/messages/2999-12-06.txt');
  check(false);
  git('rm', '-q', future);
  assert.equal(run('bash', guard).status, 1);
  git('reset', '--hard', '-q', 'HEAD');
  git('update-index', '--chmod=+x', future);
  assert.equal(run('bash', guard).status, 1);
});
