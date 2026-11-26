import assert from 'node:assert/strict';
import test from 'node:test';
import { linkConfig, runConfig } from './config.js';

const run = { GITHUB_TOKEN: 'ghp_x', REPORT_GROUP_JID: '120363025@g.us' };

test('run needs a token and the group, and applies defaults', () => {
  const c = runConfig(run);
  assert.equal(c.GITHUB_REPO, 'chrislazar25/gospel-bot');
  assert.equal(c.POLL_SECONDS, 60);
  assert.ok(c.BRIDGE_HOME.endsWith('.gospel-bridge'));
  assert.throws(() => runConfig({ REPORT_GROUP_JID: run.REPORT_GROUP_JID }));
  assert.throws(() => runConfig({ GITHUB_TOKEN: 'x' }));
  assert.throws(() => runConfig({ ...run, REPORT_GROUP_JID: '15551230000@s.whatsapp.net' }));
});

test('link and list-groups need neither token nor group', () => {
  assert.equal(linkConfig({}).PAIR_PHONE, undefined);
  assert.equal(linkConfig({ PAIR_PHONE: '15551230000' }).PAIR_PHONE, '15551230000');
});

test('pair phone must be digits and empty values count as unset', () => {
  assert.throws(() => linkConfig({ PAIR_PHONE: '+1 555 123 0000' }));
  assert.equal(runConfig({ ...run, PAIR_PHONE: '', POLL_SECONDS: '' }).POLL_SECONDS, 60);
  assert.equal(runConfig({ ...run, POLL_SECONDS: '30' }).POLL_SECONDS, 30);
});
