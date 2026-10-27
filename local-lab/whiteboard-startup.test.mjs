import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const verifier = fileURLToPath(new URL('./verify-whiteboard.mjs', import.meta.url));
for (const code of ['ENOENT', 'EACCES']) {
  test(`Chrome ${code} exits unsuccessfully and removes its isolated profile`, () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gospel-whiteboard-startup-'));
    try {
      const chrome = path.join(directory, 'chrome');
      if (code === 'EACCES') writeFileSync(chrome, '#!/bin/sh\nexit 0\n', { mode: 0o600 });
      const result = spawnSync(process.execPath, [verifier], {
        env: { ...process.env, CHROME_BIN: chrome, TMPDIR: directory },
        encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(code));
      assert.deepEqual(readdirSync(directory).filter(name => name.startsWith('gospel-whiteboard-chrome-')), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
