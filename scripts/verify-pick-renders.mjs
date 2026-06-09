// Regression guard for "picking changes the selection but you don't
// see it until you move the camera". The dirty short-circuit in
// preview-tile.tsx tracks (scene, camera, size, time, forceSerial)
// and intentionally skips draws when none of those changed. Selection
// lives inside the SceneRenderer, NOT in those tracked inputs, so
// applySelection() MUST request a FORCED render or the new selection
// outline never paints. This script picks an entity programmatically,
// then a sky point, and asserts that BOTH actions caused a submit
// while the camera stayed put.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

// Count GPUQueue.submit() calls — one per drawn tile per frame. The
// city demo's tile is the only canvas-tile in the scene at this
// point, so an idle window sees zero and a single render adds one.
await page.evaluateOnNewDocument(() => {
  window.__submits__ = 0;
  const patch = () => {
    if (typeof GPUQueue === 'undefined' || GPUQueue.prototype.__sedonPatched) return;
    GPUQueue.prototype.__sedonPatched = true;
    const orig = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (...args) {
      window.__submits__++;
      return orig.apply(this, args);
    };
  };
  patch();
  const iv = setInterval(() => { patch(); if (typeof GPUQueue !== 'undefined' && GPUQueue.prototype.__sedonPatched) clearInterval(iv); }, 50);
});

// Use the forest demo — small, has visible entities at known positions,
// faster to load than city. ANY scene with at least one entity works.
await page.goto(`${server.url}?debug=1&scene=forest`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
// Let initial frames settle so the idle-submit baseline is zero.
await new Promise((r) => setTimeout(r, 8000));

const idleBefore = await page.evaluate(async () => {
  const s0 = window.__submits__;
  await new Promise((r) => setTimeout(r, 800));
  return { delta: window.__submits__ - s0 };
});
console.log('idle baseline (800 ms):', idleBefore);

// Grab a Main-view preview canvas. The Main viewport renders the
// scene with current camera; clicking on it should trigger pickAt.
async function findMainCanvas() {
  return page.evaluateHandle(() => {
    // The main preview canvas lives inside the .sedon-preview-pane
    // root and has a non-zero size. There's exactly one per Main
    // viewport at this point.
    const canvases = [...document.querySelectorAll('canvas')];
    let best = null;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      if (!best || r.width * r.height > best.r.width * best.r.height) {
        best = { canvas: c, r };
      }
    }
    return best ? best.canvas : null;
  });
}
const mainHandle = await findMainCanvas();
const mainEl = mainHandle.asElement();
if (!mainEl) {
  console.log('FAIL: could not locate main canvas');
  await browser.close();
  await server.stop();
  process.exit(1);
}
const mainRect = await mainEl.evaluate((c) => {
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
console.log('main canvas rect:', mainRect);

// Camera snapshot — used to confirm the camera didn't move during the
// test. Any drift would invalidate "the render came from selection".
async function camera() {
  return page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const c = s.cameras.main ?? null;
    return c ? { yaw: c.yaw, pitch: c.pitch, distance: c.distance, target: [...c.target] } : null;
  });
}
const camBefore = await camera();

// ── Test A: pick an entity (click near the centre — should hit one
// of the trees in the forest demo) and confirm:
//   1) submit count went up (any draw happened — pickAt's readback
//      alone causes this, but a regression where the readback ALSO
//      doesn't happen would catch here)
//   2) force-serial went up (the FORCED render fired — this is the
//      precise signal that the selection visual got redrawn instead
//      of being short-circuited by the per-tile dirty check)
// Without #2 the test would pass even when the bug is back, because
// pickAt does GPU work either way.
async function clickAndMeasure(label, x, y) {
  const before = await page.evaluate(() => ({
    submits: window.__submits__,
    forceSerial: window.__sedonForceSerial__?.() ?? -1,
  }));
  await page.mouse.move(x, y, { steps: 2 });
  await new Promise((r) => setTimeout(r, 50));
  await page.mouse.click(x, y);
  // pickAt is async (one frame for the GPU readback) so wait a couple
  // of frames for the click → applySelection → forced rAF round-trip.
  await new Promise((r) => setTimeout(r, 250));
  const after = await page.evaluate(() => ({
    submits: window.__submits__,
    forceSerial: window.__sedonForceSerial__?.() ?? -1,
  }));
  const submitDelta = after.submits - before.submits;
  const forceDelta = after.forceSerial - before.forceSerial;
  console.log(
    `${label}: submits ${before.submits} → ${after.submits} (Δ=${submitDelta}); `
    + `forceSerial ${before.forceSerial} → ${after.forceSerial} (Δ=${forceDelta})`,
  );
  return { submitDelta, forceDelta };
}

const cx = mainRect.left + mainRect.width / 2;
const cy = mainRect.top + mainRect.height / 2;
const pick = await clickAndMeasure('Pick on entity (centre)', cx, cy);

// ── Test B: click in the sky/empty corner to DESELECT. Must also
// fire a render so the outline clears.
const skyX = mainRect.left + mainRect.width * 0.05;
const skyY = mainRect.top + mainRect.height * 0.05;
const unpick = await clickAndMeasure('Unpick (corner)', skyX, skyY);

const camAfter = await camera();
const camMoved = !camBefore || !camAfter
  || Math.abs(camBefore.yaw - camAfter.yaw) > 1e-9
  || Math.abs(camBefore.pitch - camAfter.pitch) > 1e-9
  || Math.abs(camBefore.distance - camAfter.distance) > 1e-9
  || Math.abs(camBefore.target[0] - camAfter.target[0]) > 1e-9
  || Math.abs(camBefore.target[1] - camAfter.target[1]) > 1e-9
  || Math.abs(camBefore.target[2] - camAfter.target[2]) > 1e-9;

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
console.log(`idle baseline: 0 submits in 800ms:        ${idleBefore.delta === 0 ? 'PASS ✓' : 'FAIL ✗ (' + idleBefore.delta + ')'}`);
console.log(`pick forced a render (forceSerial > 0):   ${pick.forceDelta > 0 ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`unpick forced a render (forceSerial > 0): ${unpick.forceDelta > 0 ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`pick caused some draw (submit > 0):       ${pick.submitDelta > 0 ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`unpick caused some draw (submit > 0):     ${unpick.submitDelta > 0 ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`camera did NOT move during the test:      ${!camMoved ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`console clean:                            ${errors.length === 0 ? 'PASS ✓' : 'FAIL ✗'}`);
if (errors.length) {
  for (const e of errors) console.log(' ', e);
}
const ok = idleBefore.delta === 0
  && pick.forceDelta > 0
  && unpick.forceDelta > 0
  && pick.submitDelta > 0
  && unpick.submitDelta > 0
  && !camMoved
  && errors.length === 0;
console.log(ok ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
process.exit(ok ? 0 : 1);
