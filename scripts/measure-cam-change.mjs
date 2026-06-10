// Measures what actually happens when the camera changes in the
// loaded city scene. The shot scripts timing out after
// `saveCameraFor()` made me claim speed was a problem; the
// verify-city stress test held 120 submits/sec so that claim was
// wrong. This script narrows it down: load city, wait, then for
// each `saveCameraFor` track how long it takes for the next frame
// to render and how many draws.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => { errs.push(`[pageerror] ${e.message}`); console.error('PAGEERROR:', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errs.push(`[err] ${msg.text()}`); console.error('CONSOLE-ERR:', msg.text()); }
});

await page.evaluateOnNewDocument(() => {
  window.__perf__ = { submits: 0, frameDraws: 0, totalDraws: 0, lastSubmitMs: 0 };
  const patch = () => {
    if (typeof GPUQueue === 'undefined' || GPUQueue.prototype.__sedonPatched) return;
    GPUQueue.prototype.__sedonPatched = true;
    const orig = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      window.__perf__.submits++;
      window.__perf__.totalDraws += window.__perf__.frameDraws;
      window.__perf__.frameDraws = 0;
      window.__perf__.lastSubmitMs = performance.now();
      return orig.apply(this, args);
    };
    if (typeof GPURenderPassEncoder !== 'undefined') {
      const di = GPURenderPassEncoder.prototype.drawIndexed;
      GPURenderPassEncoder.prototype.drawIndexed = function (...args) {
        window.__perf__.frameDraws++;
        return di.apply(this, args);
      };
    }
  };
  patch();
  const iv = setInterval(() => { patch(); if (typeof GPUQueue !== 'undefined' && GPUQueue.prototype.__sedonPatched) clearInterval(iv); }, 50);
});

await page.goto(`${server.url}?debug=1&scene=city`, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
console.log('page loaded, waiting 30s for initial eval to settle...');
await new Promise((r) => setTimeout(r, 30000));

const baseline = await page.evaluate(() => window.__perf__.submits);
await new Promise((r) => setTimeout(r, 2000));
const idleDelta = await page.evaluate((b) => window.__perf__.submits - b, baseline);
console.log('idle 2s submit delta:', idleDelta);

// Make 5 camera changes spaced 1s apart. Measure how soon a submit
// follows each change and how long until the second-after-change submit.
for (let i = 0; i < 5; i++) {
  const stat = await page.evaluate(async (i) => {
    const before = { t: performance.now(), submits: window.__perf__.submits };
    const s = window.__sedonStore__.getState();
    s.saveCameraFor('main', {
      yaw: 0.5 + i * 0.1,
      pitch: 0.55,
      distance: 1200,
      target: [0, 30, 0],
    });
    // Wait for the FIRST submit after the change.
    let firstSubmitMs = -1;
    const tDeadline = before.t + 5000;
    while (performance.now() < tDeadline) {
      await new Promise((r) => requestAnimationFrame(r));
      if (window.__perf__.submits > before.submits) {
        firstSubmitMs = performance.now() - before.t;
        break;
      }
    }
    return { firstSubmitMs, submits: window.__perf__.submits - before.submits };
  }, i);
  console.log(`cam change ${i}: first submit ${stat.firstSubmitMs.toFixed(0)} ms after, ${stat.submits} submits in 5s window`);
  await new Promise((r) => setTimeout(r, 1000));
}

console.log('errors:', errs.length);
await browser.close();
await server.stop();
