import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/city';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

try {
  // Patch GPURenderPassEncoder.drawIndexed (etc) + GPUQueue.submit to
  // count draws-per-frame and frame rate, before the renderer touches
  // the WebGPU API. Submit cadence = one per drawn tile per frame.
  await page.evaluateOnNewDocument(() => {
    window.__perf__ = {
      framesPerSecond: 0,
      currentFrameDraws: 0,
      lastFrameDraws: 0,
      framesObserved: 0,
      drawsObserved: 0,
      lastFlush: performance.now(),
    };
    const patch = (proto) => {
      if (!proto || proto.__sedonPatched) return;
      proto.__sedonPatched = true;
      for (const fn of ['drawIndexed', 'drawIndexedIndirect', 'draw']) {
        const orig = proto[fn];
        if (typeof orig !== 'function') continue;
        proto[fn] = function (...args) {
          window.__perf__.currentFrameDraws++;
          return orig.apply(this, args);
        };
      }
    };
    const tryPatch = () => {
      if (typeof GPURenderPassEncoder !== 'undefined') patch(GPURenderPassEncoder.prototype);
      if (typeof GPUQueue !== 'undefined' && !GPUQueue.prototype.__sedonPatched) {
        GPUQueue.prototype.__sedonPatched = true;
        const orig = GPUQueue.prototype.submit;
        GPUQueue.prototype.submit = function (...args) {
          const now = performance.now();
          const dt = now - window.__perf__.lastFlush;
          window.__perf__.lastFrameDraws = window.__perf__.currentFrameDraws;
          window.__perf__.drawsObserved += window.__perf__.currentFrameDraws;
          window.__perf__.currentFrameDraws = 0;
          window.__perf__.framesObserved++;
          window.__perf__.framesPerSecond = dt > 0 ? 1000 / dt : 0;
          window.__perf__.lastFlush = now;
          return orig.apply(this, args);
        };
      }
    };
    tryPatch();
    const iv = setInterval(() => {
      tryPatch();
      if (
        typeof GPURenderPassEncoder !== 'undefined'
        && GPURenderPassEncoder.prototype.__sedonPatched
        && typeof GPUQueue !== 'undefined'
        && GPUQueue.prototype.__sedonPatched
      ) clearInterval(iv);
    }, 50);
  });

  await page.goto(
    `${server.url}?debug=1&scene=city`,
    { waitUntil: 'networkidle2', timeout: 60000 },
  );
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 10000));

  // ── Idle-frames probe. After the city has rendered, with no input,
  // how many submits do we see in 2s? With per-tile dirty short-circuit
  // working, idle should be ~0 submits/sec; without it, every preview
  // tile redraws every frame and we'll see hundreds.
  const idleSubmits = await page.evaluate(async () => {
    const s0 = window.__perf__.framesObserved;
    const d0 = window.__perf__.drawsObserved;
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2000));
    const dt = performance.now() - t0;
    return {
      submitsDuringIdle: window.__perf__.framesObserved - s0,
      drawsDuringIdle: window.__perf__.drawsObserved - d0,
      elapsedSec: dt / 1000,
    };
  });
  console.log('\nIdle (no input) frames:');
  console.log(JSON.stringify(idleSubmits, null, 2));
  // Regression guard. With per-tile dirty short-circuit in place and
  // no input, no preview tile should redraw. If this trips, either:
  //   • someone removed the dirty check in preview-tile.tsx / scene-
  //     preview.tsx, or
  //   • a new code path is calling requestRender() every frame, or
  //   • a requestRender({ force: true }) is firing when it shouldn't,
  //     bumping the force-serial and busting every tile's dirty check.
  // Pre-fix baseline was ~30+ submits per frame at idle with this city
  // demo loaded. Strict zero — even one submit/sec means something is
  // wrong; the editor was meant to be fully idle here.
  if (idleSubmits.submitsDuringIdle !== 0) {
    errors.push(
      `[idle-perf] expected 0 submits during 2s idle window, got `
      + `${idleSubmits.submitsDuringIdle} (${idleSubmits.drawsDuringIdle} draws). `
      + `Likely cause: per-tile dirty short-circuit regressed, or some `
      + `caller is firing requestRender() every frame.`,
    );
  }

  await page.screenshot({ path: `${OUT}/overview.png` });

  // ── Active-frames probe: jiggle the main camera for 2s and measure.
  const active = await page.evaluate(async () => {
    window.__perf__.framesObserved = 0;
    window.__perf__.drawsObserved = 0;
    window.__perf__.lastFlush = performance.now();
    const s = window.__sedonStore__.getState();
    const cam0 = s.cameras.main ?? { yaw: 0.5, pitch: 0.55, distance: 1200, target: [0, 30, 0] };
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      s.saveCameraFor('main', { ...cam0, yaw: cam0.yaw + 0.001 * (performance.now() - t0) });
      await new Promise((r) => requestAnimationFrame(r));
    }
    const elapsed = (performance.now() - t0) / 1000;
    return {
      submits: window.__perf__.framesObserved,
      draws: window.__perf__.drawsObserved,
      avgDrawsPerSubmit: window.__perf__.framesObserved > 0
        ? (window.__perf__.drawsObserved / window.__perf__.framesObserved)
        : 0,
      submitsPerSec: window.__perf__.framesObserved / elapsed,
      elapsedSec: elapsed,
    };
  });
  console.log('\nActive (camera-jiggle) frames:');
  console.log(JSON.stringify(active, null, 2));

  await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    s.saveCameraFor('main', { yaw: 0.3, pitch: 0.15, distance: 80, target: [0, 5, 0] });
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${OUT}/street-level.png` });

  await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    s.saveCameraFor('main', { yaw: 0, pitch: 1.4, distance: 1500, target: [0, 0, 0] });
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${OUT}/top-down.png` });

  const state = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      subgraphCount: s.subgraphs.length,
      mainNodeCount: s.mainGraph.nodes.length,
    };
  });
  console.log('\nDemo state:', JSON.stringify(state, null, 2));

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
