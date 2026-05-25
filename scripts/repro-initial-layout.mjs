// Default DockView layout. Verifies:
//   1. Three panels (canvas-main, preview-main, assets-main) all
//      mount on first load.
//   2. Assets sits BELOW Canvas (Assets.top > Canvas.top, and Assets.left
//      ≈ Canvas.left — they share the left column).
//   3. Preview spans the full height of the left column's stack
//      (Preview.top ≈ Canvas.top, Preview.bottom ≈ Assets.bottom).
//   4. Assets is roughly 25% of the canvas+assets vertical, within
//      a reasonable tolerance.

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

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonGetDockview__ === 'function', { timeout: 10000 });

// Give DockView a moment to apply initialHeight after mount.
await new Promise((r) => setTimeout(r, 800));

const layout = await page.evaluate(() => {
  const api = window.__sedonGetDockview__();
  const out = {};
  for (const p of api.panels) {
    // Each panel has a `.view.element` DOM node.
    const el = p.view?.element ?? p.view?.content?.element ?? null;
    if (!el) { out[p.id] = null; continue; }
    const r = el.getBoundingClientRect();
    out[p.id] = {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }
  return { panels: out, winH: window.innerHeight, winW: window.innerWidth };
});
console.log('layout:', JSON.stringify(layout, null, 2));

const c = layout.panels['canvas-main'];
const p = layout.panels['preview-main'];
const a = layout.panels['assets-main'];

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
if (!c || !p || !a) {
  console.log('FAIL: missing one of canvas/preview/assets');
  process.exit(1);
}

const allMounted = !!(c && p && a);
// Assets below Canvas, sharing left column.
const assetsBelowCanvas = a.top >= c.bottom - 6 && Math.abs(a.left - c.left) < 4;
// Preview on the right, spanning vertically from canvas top to assets
// bottom (the full left-column height).
const previewRightOfCanvas = p.left >= c.right - 6;
const previewSpansVertically = Math.abs(p.top - c.top) < 6
  && Math.abs(p.bottom - a.bottom) < 6;
// Assets is roughly 25% of (canvas+assets) height. Allow 18-32% as the
// 25% target is approximate (we set initialHeight from window.innerHeight,
// which is slightly larger than the actual column due to top toolbar).
const colHeight = c.height + a.height;
const ratio = a.height / colHeight;
const ratioOk = ratio >= 0.18 && ratio <= 0.32;

console.log(`all 3 panels mounted:               ${allMounted ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`assets below canvas (left column):  ${assetsBelowCanvas ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`preview right of canvas:            ${previewRightOfCanvas ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`preview spans full vertical height: ${previewSpansVertically ? 'PASS ✓' : 'FAIL ✗'} (canvas.top=${c.top} preview.top=${p.top}; assets.bottom=${a.bottom} preview.bottom=${p.bottom})`);
console.log(`assets ~25% of canvas+assets:       ${ratioOk ? 'PASS ✓' : 'FAIL ✗'} (ratio=${(ratio * 100).toFixed(1)}%)`);

const ok = allMounted && assetsBelowCanvas && previewRightOfCanvas && previewSpansVertically && ratioOk;
process.exit(ok ? 0 : 1);
