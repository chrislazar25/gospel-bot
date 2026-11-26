import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub } from './github.js';

const config = { token: 'ghp_secret', repo: 'o/r' };
type Call = { url: string; init: RequestInit };
const fake = (status: number, body: unknown) => {
  const calls: Call[] = [];
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, request };
};

test('create posts the issue and returns its number', async () => {
  const { calls, request } = fake(201, { number: 42, extra: 'ignored' });
  const n = await createGithub(config, request).create({ title: 't', body: 'b', labels: ['benny:new'] });
  assert.equal(n, 42);
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/o/r/issues');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { title: 't', body: 'b', labels: ['benny:new'] });
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer ghp_secret');
});

test('get returns labels, state and reason', async () => {
  const { calls, request } = fake(200, {
    number: 5, state: 'closed', state_reason: 'completed', labels: [{ name: 'benny:pr' }, 'benny:report'],
  });
  assert.deepEqual(await createGithub(config, request).get(5), {
    number: 5, state: 'closed', stateReason: 'completed', labels: ['benny:pr', 'benny:report'],
  });
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/o/r/issues/5');
  assert.equal(calls[0]!.init.method, 'GET');
});

test('a missing state_reason reads as null', async () => {
  const { request } = fake(200, { number: 5, state: 'open', labels: [] });
  assert.equal((await createGithub(config, request).get(5)).stateReason, null);
});

test('a response of the wrong shape is rejected', async () => {
  await assert.rejects(createGithub(config, fake(200, { number: 'five', state: 'open', labels: [] }).request).get(5));
  await assert.rejects(createGithub(config, fake(200, { state: 'open', labels: [] }).request).get(5));
  await assert.rejects(createGithub(config, fake(201, {}).request).create({ title: 't', body: 'b', labels: [] }));
});

test('an http error is rejected without leaking the token', async () => {
  await assert.rejects(createGithub(config, fake(404, { message: 'Not Found' }).request).get(9), (e: Error) => {
    assert.equal(e.message, 'github_404');
    return true;
  });
});
