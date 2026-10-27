import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.dirname(fileURLToPath(import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gospel-whiteboard-chrome-'));
const evidence = path.join(root, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const exited = new Promise(resolve => chrome.once('exit', resolve));
let ws;
let call;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !fs.existsSync(portFile) && attempt < 150; attempt++) await delay(100);
  assert.ok(fs.existsSync(portFile), 'Chrome exposed its isolated CDP port');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const externalRequests = [];
  ws.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails);
    if (response.method === 'Network.requestWillBeSent' && /^https?:/.test(response.params.request.url)) externalRequests.push(response.params.request.url);
    if (response.id) {
      const request = pending.get(response.id);
      pending.delete(response.id);
      if (response.error) request.reject(new Error(JSON.stringify(response.error)));
      else request.resolve(response.result);
    }
  });
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
  const scenarios = {
    success: 'The app saves a delivery ID, sends once, then records acceptance. A delivery receipt confirms arrival.',
    reject: 'The fake API proves it rejected the request. The same delivery can be retried safely.',
    unknown: 'The fake API accepts, then drops the connection. The app holds the delivery as unknown. It checks evidence instead of blindly sending again.',
    repeat: 'Both app instances ask Postgres for the same daily delivery. Only one can claim the send. Both requests return the same delivery ID.'
  };
  const results = [];
  for (const [name, width, height, mobile] of [['desktop', 1440, 1100, false], ['mobile', 390, 844, true]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await call('Page.navigate', { url: pathToFileURL(path.join(root, 'WHITEBOARD.html')).href });
    await evaluate("new Promise(resolve => document.readyState === 'complete' ? resolve(true) : window.addEventListener('load', () => resolve(true), { once: true }))");
    await evaluate('document.fonts.ready.then(() => true)');
    const dimensions = await evaluate('({ viewport: innerWidth, document: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })');
    assert.equal(dimensions.viewport, width);
    assert.ok(dimensions.document <= width, `${name} has no horizontal overflow`);
    assert.equal(await evaluate("document.querySelectorAll('[data-mode]').length"), 4);
    assert.equal(await evaluate("document.getElementById('story').getAttribute('aria-live')"), 'polite');
    for (const [mode, story] of Object.entries(scenarios)) {
      await evaluate(`document.querySelector('[data-mode="${mode}"]').click()`);
      assert.equal(await evaluate("document.getElementById('story').textContent"), story);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('[aria-pressed=true]')].map(button => button.dataset.mode)"), [mode]);
      assert.equal(await evaluate("document.querySelectorAll('[aria-pressed=false]').length"), 3);
    }
    await evaluate("document.querySelector('[data-mode=success]').click(); scrollTo(0, 0)");
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: dimensions.height, scale: 1 } });
    fs.writeFileSync(path.join(evidence, `whiteboard-${name}.png`), Buffer.from(screenshot.data, 'base64'));
    results.push({ name, ...dimensions, scenariosPassed: 4 });
  }
  assert.deepEqual(errors, [], 'No JavaScript exceptions');
  assert.deepEqual(externalRequests, [], 'No external page requests');
  const report = { results, javascriptErrors: errors.length, externalRequests: externalRequests.length };
  fs.writeFileSync(path.join(evidence, 'whiteboard-qa.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ws?.readyState === WebSocket.OPEN) void call('Browser.close').catch(() => {});
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  }
  if (chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGKILL');
    await exited;
  }
  ws?.close();
  await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
