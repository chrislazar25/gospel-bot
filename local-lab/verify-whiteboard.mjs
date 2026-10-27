import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { connectCdp } from './whiteboard-cdp.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gospel-whiteboard-chrome-'));
const evidence = path.join(root, 'evidence');
let chrome;
let closed;
let ws;
let call;
try {
  fs.mkdirSync(evidence, { recursive: true });
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  closed = new Promise(resolve => chrome.once('close', resolve));
  await new Promise((resolve, reject) => {
    chrome.once('spawn', resolve);
    chrome.once('error', reject);
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; !fs.existsSync(portFile) && attempt < 150; attempt++) await delay(100);
  assert.ok(fs.existsSync(portFile), 'Chrome exposed its isolated CDP port');
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
  ws = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  const errors = [];
  const externalRequests = [];
  call = connectCdp(ws);
  ws.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data);
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails);
    if (response.method === 'Network.requestWillBeSent' && /^https?:/.test(response.params.request.url)) externalRequests.push(response.params.request.url);
  });
  await call.ready;
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
    unknown: 'The fake API accepts, then drops the connection. The app holds the delivery as unknown. It cannot recover the lost provider ID and will not send again automatically.',
    repeat: 'Both app instances ask Postgres for the same daily delivery. Only one can claim the send. Both requests return the same delivery ID.'
  };
  const results = [];
  for (const [name, width, height, mobile] of [['desktop', 1440, 1100, false], ['mobile', 390, 844, true]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await call('Page.navigate', { url: pathToFileURL(path.join(root, 'WHITEBOARD.html')).href });
    await evaluate("new Promise(resolve => document.readyState === 'complete' ? resolve(true) : window.addEventListener('load', () => resolve(true), { once: true }))");
    await evaluate('document.fonts.ready.then(() => true)');
    const dimensions = await evaluate('({ viewport: innerWidth, document: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })');
    const diagrams = await evaluate(`Object.fromEntries(['svg', '.mobile-board'].map(selector => {
      const element = document.querySelector(selector);
      return [selector, Boolean(element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0)];
    }))`);
    assert.deepEqual(diagrams, { svg: !mobile, '.mobile-board': mobile }, `${name} shows only its intended diagram`);
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
  if (call && ws?.readyState === WebSocket.OPEN) void call('Browser.close').catch(() => {});
  if (closed) await Promise.race([closed, delay(3000, undefined, { ref: false })]);
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([closed, delay(3000, undefined, { ref: false })]);
  }
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGKILL');
    await closed;
  }
  ws?.close();
  await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
