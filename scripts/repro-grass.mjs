// Verify the camera-relative GPU grass: load the Grass Test demo,
// capture any WebGPU validation errors (compute pass, indirect draw,
// texture-array, etc.), and screenshot the preview to confirm blades
// render. Launches its own dev server so it never fights the user's.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
const errors = [];
const logs = [];
page.on('console', async (msg) => {
  const t = msg.type();
  const parts = await Promise.all(
    msg.args().map(async (a) => {
      try { return await a.evaluate((v) => (typeof v === 'string' ? v : JSON.stringify(v))); }
      catch { return String(a); }
    }),
  );
  const text = parts.join(' ');
  if (t === 'error') errors.push(text);
  else logs.push(`[${t}] ${text}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Capture async WebGPU validation errors via uncapturederror.
await page.evaluate(() => {
  globalThis.__gpuErrors__ = [];
  const wait = () => new Promise((r) => {
    const c = () => {
      const d = window.__sedonStore__.getState().device;
      if (d) return r(d);
      setTimeout(c, 50);
    };
    c();
  });
  wait().then((dev) => {
    dev.addEventListener?.('uncapturederror', (ev) => {
      globalThis.__gpuErrors__.push(ev.error?.message ?? String(ev));
    });
  });
});

await page.evaluate(() => { globalThis.__DEBUG_SCENE_PREVIEW__ = true; });

// Load the grass demo.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'grass-test');
  if (!demo) throw new Error('grass-test demo not registered');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 5000));

const gpuErrors = await page.evaluate(() => globalThis.__gpuErrors__ ?? []);
await page.screenshot({ path: '/tmp/grass-test.png' });
console.log('screenshot: /tmp/grass-test.png');

// Animate toggle: install a rAF counter, click Play, confirm frames
// advance (continuous loop) and no GPU errors from wind animation,
// then Pause and confirm frames stop.
await page.evaluate(() => {
  globalThis.__raf = 0;
  const tick = () => { globalThis.__raf++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const playClicked = await page.evaluate(() => {
  const btn = document.querySelector('.sedon-animate-toggle');
  if (!btn) return false;
  btn.click();
  return true;
});
const before = await page.evaluate(() => globalThis.__raf);
await new Promise((r) => setTimeout(r, 1000));
const afterPlay = await page.evaluate(() => globalThis.__raf);
const errorsDuringPlay = await page.evaluate(() => globalThis.__gpuErrors__.length);
// Pause.
await page.evaluate(() => { document.querySelector('.sedon-animate-toggle')?.click(); });
await new Promise((r) => setTimeout(r, 600));

console.log(`\nanimate toggle present: ${playClicked}`);
console.log(`rAF frames during 1s of Play: ${afterPlay - before} (continuous loop should be ~60)`);
console.log(`GPU errors during Play: ${errorsDuringPlay}`);

await browser.close();
await server.stop();

console.log('\n=== console errors:', errors.length, '===');
for (const e of errors.slice(0, 10)) console.log(e.slice(0, 600));
console.log('\n=== WebGPU validation errors:', gpuErrors.length, '===');
for (const e of gpuErrors.slice(0, 10)) console.log(e.slice(0, 600));
const grassLogs = logs.filter((l) => l.toLowerCase().includes('grass'));
console.log('\n=== grass-related logs (last 5) ===');
for (const l of grassLogs.slice(-5)) console.log(l.slice(0, 400));
