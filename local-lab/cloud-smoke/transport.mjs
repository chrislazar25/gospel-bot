import assert from 'node:assert/strict';
import { mock } from 'node:test';

assert.equal(process.env.APP_ENV, 'staging');
assert.equal(process.env.GREEN_API_URL, 'https://smoke.api.green-api.com');
assert.equal(process.env.GREEN_API_ID, '0');
assert.equal(process.env.GREEN_API_TOKEN, 'cloud_smoke_synthetic_only');
assert.equal(process.env.TARGET_CHAT_ID, '000000000000@g.us');
const port = Number(process.env.SMOKE_PROVIDER_PORT);
assert(Number.isInteger(port) && port > 0 && port < 65536);
const now = Date.parse(process.env.SMOKE_NOW);
assert(Number.isFinite(now));
mock.timers.enable({ apis: ['Date'], now });

const request = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(String(input));
  const allowed = /^\/waInstance0\/(getStateInstance|sendMessage|getMessage)\/cloud_smoke_synthetic_only$/;
  if (url.origin !== 'https://smoke.api.green-api.com' || url.username || url.password || url.search || url.hash || !allowed.test(url.pathname)) {
    throw new Error('smoke_destination_blocked');
  }
  return request(`http://127.0.0.1:${port}${url.pathname}`, { ...options, redirect: 'error' });
};
