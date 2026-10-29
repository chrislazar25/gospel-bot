import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { CANARY_CONFIRMATION, canaryConfigSchema, main } from './canary.js';

export const fixture = {
  APP_ENV: 'staging', CANARY_CONFIRMATION, CANARY_TARGET_CHAT_ID: '15555550123@c.us', CANARY_ATTEMPT: '1',
  RELEASE_SHA: 'a'.repeat(40), CANARY_EXPECTED_REVISION: 'a'.repeat(40),
  DATABASE_URL: 'postgres://gospel_runtime:synthetic@db:5432/canary',
  STATUS_DATABASE_URL: 'postgres://gospel_status:synthetic@db:5432/canary',
  GREEN_API_URL: 'https://7107.api.greenapi.com', GREEN_API_ID: '1234', GREEN_API_TOKEN: 'synthetic-token',
};
test('canary boundary validates staging, authorization, revision, credentials and private recipient before opening resources', async () => {
  assert.equal(canaryConfigSchema.parse(fixture).APP_ENV, 'staging');
  for (const invalid of [
    { APP_ENV: 'production' }, { CANARY_CONFIRMATION: '' }, { CANARY_TARGET_CHAT_ID: '120363000000000000@g.us' },
    { CANARY_TARGET_CHAT_ID: '15555550123@c.us\n' }, { CANARY_ATTEMPT: undefined }, { CANARY_ATTEMPT: '0' }, { CANARY_ATTEMPT: '01' }, { CANARY_ATTEMPT: '366' }, { CANARY_ATTEMPT: '1.5' }, { CANARY_EXPECTED_REVISION: 'b'.repeat(40) }, { RELEASE_SHA: 'unreleased' },
    { DATABASE_URL: 'postgres://neondb_owner:synthetic@db:5432/canary' },
    { STATUS_DATABASE_URL: fixture.DATABASE_URL }, { STATUS_DATABASE_URL: 'postgres://gospel_status:synthetic@other:5432/canary' },
    { GREEN_API_URL: 'https://evil.example' }, { GREEN_API_ID: 'not-an-instance' }, { GREEN_API_TOKEN: '' },
  ]) await assert.rejects(main([], { ...fixture, ...invalid }), z.ZodError);
  await assert.rejects(main(['send'], fixture), /unexpected_arguments/);
});
