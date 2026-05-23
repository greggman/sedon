// Verify that a two-finger pinch on the preview dollies the camera —
// pinch out (fingers moving apart) should zoom IN (camera.distance
// decreases), matching how a mouse-wheel scroll-up zooms in.

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
// Touch input must be advertised so Chromium routes the dispatched
// touch events into Pointer Events with pointerType='touch'.
await page.setViewport({ width: 1400, height: 900, hasTouch: true, isMobile: false, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));

// Locate the preview canvas centre.
const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-preview-canvas');
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = rect.x + rect.w / 2;
const cy = rect.y + rect.h / 2;

const session = await page.target().createCDPSession();
const dispatch = (type, points) => session.send('Input.dispatchTouchEvent', { type, touchPoints: points });

// commitCamera writes the per-panel + per-graph + LRU slots on pointerup.
// Read from any of them, in priority order.
const distance = () => page.evaluate(() => {
  const lay = window.__sedonLayoutStore__.getState();
  const ed = window.__sedonStore__.getState();
  const panelId = lay.lastActivePreviewPanelId ?? Object.keys(lay.previewCameras)[0];
  return (panelId && lay.previewCameras[panelId]?.main?.distance)
    ?? lay.recentPreviewCameras?.main?.distance
    ?? ed.projectCameras?.main?.distance
    ?? null;
});

// Pinch-OUT gesture: two fingers start 60px apart and end 200px apart.
// Expectation: dollies IN → distance decreases.
async function pinchOut() {
  const t1 = { id: 1, x: cx - 30, y: cy };
  const t2 = { id: 2, x: cx + 30, y: cy };
  await dispatch('touchStart', [t1, t2]);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const spread = 30 + (70 * i) / steps;
    await dispatch('touchMove', [
      { id: 1, x: cx - spread, y: cy },
      { id: 2, x: cx + spread, y: cy },
    ]);
    await new Promise((r) => setTimeout(r, 20));
  }
  await dispatch('touchEnd', []);
}

// Use a tiny mouse-wheel to commit the camera's current distance into
// the layout store so we have a baseline to read.
await page.mouse.move(cx, cy);
await page.mouse.wheel({ deltaY: 1 });
await new Promise((r) => setTimeout(r, 300));
const before = await distance();
console.log('distance before pinch-out:', before);

await pinchOut();
await new Promise((r) => setTimeout(r, 400));
const afterOut = await distance();
console.log('distance after  pinch-out:', afterOut);

// Sanity in the OTHER direction: pinch-IN should dolly OUT (distance up).
async function pinchIn() {
  await dispatch('touchStart', [{ id: 1, x: cx - 100, y: cy }, { id: 2, x: cx + 100, y: cy }]);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const spread = 100 - (70 * i) / steps;
    await dispatch('touchMove', [
      { id: 1, x: cx - spread, y: cy },
      { id: 2, x: cx + spread, y: cy },
    ]);
    await new Promise((r) => setTimeout(r, 20));
  }
  await dispatch('touchEnd', []);
}
await pinchIn();
await new Promise((r) => setTimeout(r, 400));
const afterIn = await distance();
console.log('distance after  pinch-in: ', afterIn);

await browser.close();
await server.stop();

const ok =
  before !== null && afterOut !== null && afterIn !== null &&
  afterOut < before - 1 &&    // pinch-out → dolly in
  afterIn > afterOut + 1;     // pinch-in  → dolly out
console.log('\n===== RESULT =====');
console.log(ok
  ? `PASS ✓ pinch-out ${before.toFixed(1)} → ${afterOut.toFixed(1)}; pinch-in → ${afterIn.toFixed(1)}`
  : `FAIL ✗ before=${before} afterOut=${afterOut} afterIn=${afterIn}`);
process.exit(ok ? 0 : 1);
