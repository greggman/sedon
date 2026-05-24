// P2 GPU picking end-to-end. Loads the forest demo, hovers over the
// middle of the preview canvas, presses F, and asserts the camera
// moved to roughly where the picked instance lives. Also checks that
// clicking the SKY (background pixel) does nothing — pickId 0 = miss.
//
// We don't try to validate the exact entity selected — point clouds
// have stochastic placements per build. Instead we verify:
//   1. Forest renders 0 GPU errors with the new pick pipeline live.
//   2. F over the centre of the canvas moves the camera (target or
//      distance must change from the demo's authored default).
//   3. F with cursor over the sky (top edge of canvas) leaves the
//      camera UNCHANGED — the miss path doesn't accidentally frame
//      origin or anything.

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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const gpuErrors = [];
page.on('console', (msg) => {
  const t = msg.text();
  if (/webgpu|validation/i.test(t)) gpuErrors.push(t);
  if (/uncaptured/.test(t)) console.log('  ', t);
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Surface uncaptured WebGPU errors — they otherwise go nowhere.
await page.evaluate(() => {
  globalThis.__webgpuErrors = [];
  const hook = () => {
    const dev = window.__sedonStore__.getState().device;
    if (dev && !dev.__hookedPick) {
      dev.__hookedPick = true;
      dev.addEventListener('uncapturederror', (e) => {
        globalThis.__webgpuErrors.push(String(e.error.message));
        console.log('[uncapturederror]', String(e.error.message));
      });
    }
    requestAnimationFrame(hook);
  };
  hook();
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));

// Find the preview canvas + its rect.
const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-preview-canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
if (!rect) { console.log('FAIL: no preview canvas'); process.exit(1); }
console.log('preview rect:', rect);

// Read the saved/active camera so we can compare before/after F.
const readCam = () => page.evaluate(() => {
  const lay = window.__sedonLayoutStore__.getState();
  const panelId = lay.lastActivePreviewPanelId ?? Object.keys(lay.previewCameras)[0];
  return (panelId && lay.previewCameras[panelId]?.main)
    ?? lay.recentPreviewCameras?.main
    ?? window.__sedonStore__.getState().projectCameras?.main
    ?? null;
});

// Click on the sky (clearly above terrain in the authored forest
// framing) to focus the wrapper + clear any selection so we have a
// known "nothing selected" starting state.
const cx = rect.x + rect.w * 0.5;
const cy = rect.y + rect.h * 0.6; // a bit below centre — should hit a tree
const skyX = rect.x + rect.w * 0.5;
const skyY = rect.y + 8;
await page.mouse.click(skyX, skyY);
await new Promise((r) => setTimeout(r, 300));

const before = await readCam();
console.log('camera BEFORE F:', before ? { target: before.target, distance: before.distance.toFixed(2) } : 'null');

// ---- 1. F WITH NOTHING SELECTED: must be a no-op (the user-supplied
// rule is "F = view selected", a no-op without a selection). ----
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 800));
const afterMiss = await readCam();
console.log('camera AFTER F (no selection):', afterMiss ? { target: afterMiss.target, distance: afterMiss.distance.toFixed(2) } : 'null');

// ---- 2. CLICK A TREE, THEN F: the click selects without framing, and
// F frames the selection. Camera must move to a non-default position. ----
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 500)); // give pick + setSelection a moment
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 1500));
const afterHit = await readCam();
console.log('camera AFTER F (selected):    ', afterHit ? { target: afterHit.target, distance: afterHit.distance.toFixed(2) } : 'null');

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
// Sky-miss check: camera must not have moved from `before` after the
// first F. Tolerance is generous because the click above commits the
// camera once (tiny floating-point shuffle) but the F over sky should
// add zero movement on top.
const skyUntouched = before && afterMiss && (
  Math.hypot(
    afterMiss.target[0] - before.target[0],
    afterMiss.target[1] - before.target[1],
    afterMiss.target[2] - before.target[2],
  ) < 0.5 && Math.abs(afterMiss.distance - before.distance) < 0.5
);
// Geometry-hit check: camera must have moved meaningfully (forest tree
// placements are tens of metres apart; framing distance is ~5m vs
// forest default 95m, so the change is huge).
const moved = afterMiss && afterHit && (
  Math.hypot(
    afterHit.target[0] - afterMiss.target[0],
    afterHit.target[1] - afterMiss.target[1],
    afterHit.target[2] - afterMiss.target[2],
  ) > 0.5 || Math.abs(afterHit.distance - afterMiss.distance) > 0.5
);
console.log(`F with no selection is a no-op:   ${skyUntouched ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`F frames the click-selected tree: ${moved ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`GPU validation/console errors: ${gpuErrors.length === 0 ? 'PASS ✓' : `FAIL ✗ (${gpuErrors.length} errors)`}`);
if (gpuErrors.length) console.log(gpuErrors.slice(0, 5));
process.exit(moved && skyUntouched && gpuErrors.length === 0 ? 0 : 1);
