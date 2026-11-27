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

test('upload puts the file on the media branch and returns its raw url', async () => {
  const { calls, request } = fake(201, { content: {} });
  const url = await createGithub(config, request).upload('reports/M1.jpg', Buffer.from('abc'));
  assert.equal(url, 'https://raw.githubusercontent.com/o/r/benny-media/reports/M1.jpg');
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/o/r/contents/reports/M1.jpg');
  assert.equal(calls[0]!.init.method, 'PUT');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.branch, 'benny-media');
  assert.equal(Buffer.from(body.content, 'base64').toString(), 'abc');
});

const byMethod = (statuses: Record<string, number>) => (async (_url: string, init: RequestInit) =>
  new Response('{}', { status: statuses[init.method!]! })) as unknown as typeof fetch;

test('upload accepts 422 only when the file is already on the media branch', async () => {
  assert.match(await createGithub(config, byMethod({ PUT: 422, GET: 200 })).upload('reports/M1.jpg', Buffer.from('a')), /benny-media\/reports\/M1\.jpg$/);
  await assert.rejects(createGithub(config, byMethod({ PUT: 422, GET: 404 })).upload('reports/M1.jpg', Buffer.from('a')), /github_404/);
  await assert.rejects(createGithub(config, byMethod({ PUT: 404 })).upload('reports/M1.jpg', Buffer.from('a')), /github_404/);
});

test('comment and addLabel post to the issue', async () => {
  const { calls, request } = fake(201, {});
  const gh = createGithub(config, request);
  await gh.comment(5, 'hello');
  await gh.addLabel(5, 'benny:triage-again');
  assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
    ['POST', 'https://api.github.com/repos/o/r/issues/5/comments'], ['POST', 'https://api.github.com/repos/o/r/issues/5/labels'],
  ]);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { body: 'hello' });
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { labels: ['benny:triage-again'] });
});

test('hasComment pages through the issue comments looking for the marker', async () => {
  const pages: Record<string, object[]> = {
    1: Array.from({ length: 100 }, () => ({ body: 'other' })),
    2: [{ body: null }, { body: 'detail\n\n<!-- wa-followup:F1 -->' }],
  };
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[new URL(url).searchParams.get('page')!] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  const gh = createGithub(config, request);
  assert.equal(await gh.hasComment(5, '<!-- wa-followup:F1 -->'), true);
  assert.equal(await gh.hasComment(5, '<!-- wa-followup:F2 -->'), false);
  assert.equal(urls[0], 'https://api.github.com/repos/o/r/issues/5/comments?per_page=100&page=1');
  assert.equal(urls.length, 4);
});

const since = new Date('2026-11-26T10:00:00.000Z');
const at = (minutes: number) => new Date(since.getTime() + minutes * 60000).toISOString();

test('findByMarker returns the report issue created since the cutoff whose body carries the marker, never a pull request', async () => {
  const { calls, request } = fake(200, [
    { number: 9, body: 'x <!-- wa-message:M1 --> pr', created_at: at(3), pull_request: {} }, { number: 8, body: null, created_at: at(2) },
    { number: 7, body: 'text\n\n<!-- wa-message:M1 -->', created_at: at(1) }, { number: 6, body: '<!-- wa-message:M2 -->', created_at: at(-1) },
  ]);
  const gh = createGithub(config, request);
  assert.equal(await gh.findByMarker('<!-- wa-message:M1 -->', since), 7);
  assert.equal(await gh.findByMarker('<!-- wa-message:M2 -->', since), undefined);
  assert.equal(await gh.findByMarker('<!-- wa-message:M3 -->', since), undefined);
  assert.equal(calls[0]!.url, 'https://api.github.com/repos/o/r/issues?labels=benny%3Areport&state=all&sort=created&direction=desc&since=2026-11-26T10%3A00%3A00.000Z&per_page=100&page=1');
});

test('findByMarker pages past 100 newer issues and stops at the first issue older than the cutoff', async () => {
  const pages: Record<string, object[]> = {
    1: Array.from({ length: 100 }, (_, i) => ({ number: 500 - i, body: 'other', created_at: at(200 - i) })),
    2: [{ number: 400, body: 'other', created_at: at(50) }, { number: 399, body: 'old <!-- wa-message:M9 -->', created_at: at(-10) }],
    3: [{ number: 300, body: '<!-- wa-message:M1 -->', created_at: at(-20) }],
  };
  const urls: string[] = [];
  const request = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[new URL(url).searchParams.get('page')!] ?? []), { status: 200 });
  }) as unknown as typeof fetch;
  const gh = createGithub(config, request);
  pages[2]!.unshift({ number: 401, body: '<!-- wa-message:M1 -->', created_at: at(60) });
  assert.equal(await gh.findByMarker('<!-- wa-message:M1 -->', since), 401);
  urls.length = 0;
  assert.equal(await gh.findByMarker('<!-- wa-message:M9 -->', since), undefined);
  assert.deepEqual(urls.map((u) => new URL(u).searchParams.get('page')), ['1', '2']);
});
