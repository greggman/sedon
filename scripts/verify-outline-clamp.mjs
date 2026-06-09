// Repros & regression-tests the outline-wrap bug. Clicks halfway
// across the forest preview at y = height/6 (the user's repro:
// either a tree or the terrain gets picked at that point). Reads
// the canvas's pixel rows at the TOP and BOTTOM edges. With the
// composite-sampler bug (addressMode='repeat'), one of those edge
// rows holds bright orange pixels from the wrapped outline. With
// the fix (clamp-to-edge) both edge rows stay clean.
//
// Bug detection: count pixels matching the outline colour
// (orange-ish, R high G mid B low) in the top and bottom rows. A
// hit > a small threshold means the outline wrapped.

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

await page.goto(`${server.url}?debug=1&scene=forest`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 8000));

// Find the main preview canvas.
const mainHandle = await page.evaluateHandle(() => {
  const canvases = [...document.querySelectorAll('canvas')];
  let best = null;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) continue;
    if (!best || r.width * r.height > best.r.width * best.r.height) best = { canvas: c, r };
  }
  return best ? best.canvas : null;
});
const mainEl = mainHandle.asElement();
if (!mainEl) {
  console.log('FAIL: no main canvas');
  await browser.close(); await server.stop(); process.exit(1);
}
const rect = await mainEl.evaluate((c) => {
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
});
console.log('canvas rect:', rect);

// Click halfway across, 1/6 down — the user's repro point. With the
// bug, this picks something near the top edge and the wrapped
// outline lands at the bottom; or picks terrain near the bottom and
// the wrapped outline lands at the top.
const clickX = rect.left + rect.width / 2;
const clickY = rect.top + rect.height / 6;
console.log('clicking at', clickX, clickY);
await page.mouse.move(clickX, clickY, { steps: 2 });
await page.mouse.click(clickX, clickY);
// Wait for the forced render to paint the outline.
await new Promise((r) => setTimeout(r, 500));

// Read canvas pixels via the puppeteer screencast path. We screenshot
// to a buffer, parse the PNG with sharp-less PNG reading by going
// through page.evaluate + canvas.toDataURL fallback.
// Simpler: just use page.screenshot on the canvas element.
// Screenshot the preview canvas region as PNG, base64 it, decode
// inside the page via Image + drawImage so we can getImageData.
// Direct drawImage(webgpuCanvas → 2dCanvas) returns blank because
// the WebGPU swap chain is not readable from a 2D ctx; this PNG
// round-trip is the trick existing repro scripts use.
const clip = {
  x: Math.round(rect.left),
  y: Math.round(rect.top),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
};
const buf = await page.screenshot({ type: 'png', clip });
await import('node:fs/promises').then((fs) => fs.writeFile('/tmp/city-outline-wrap.png', buf));
console.log('canvas screenshot: /tmp/city-outline-wrap.png');
const b64 = buf.toString('base64');
const wrapStats = await page.evaluate(async (b64, w, h) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  // Outline colour is (255, 165, 38) — see scene.ts L2479 where the
  // outline-composite uniform is written as (1.0, 0.65, 0.15, 1.0).
  // Tolerant match: clearly orange (R high, B much lower, R-G gap
  // matches the rendered colour, AA pixels still counted).
  function countOrange(y0, y1) {
    const data = ctx.getImageData(0, y0, w, y1 - y0).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 200 && b < 160 && r > g + 30 && g > b + 30) count++;
    }
    return count;
  }
  // 4-pixel band at each edge — captures the 2-texel outline ring
  // plus a small margin so we don't miss it at high DPR. With the
  // bug, one of these is large because the composite's `uv + off`
  // sample wrapped to the opposite edge.
  const top = countOrange(0, 4);
  const bot = countOrange(h - 4, h);
  // Total orange anywhere — sanity check that the outline is being
  // drawn at all (otherwise "edges clean" passes vacuously).
  const total = countOrange(0, h);
  return { w, h, topRows: top, botRows: bot, totalOrange: total };
}, b64, clip.width, clip.height);

await browser.close();
await server.stop();

console.log('\n===== wrap stats =====');
console.log(JSON.stringify(wrapStats, null, 2));

// With the bug: one of topRows/botRows is large (dozens+) because
// the composite's `uv + off` sample wraps to the opposite edge of
// the mask. Without: both stay near zero (a few stray AA pixels at
// most). `totalOrange` confirms the test actually exercised the
// outline pass — without it, "edges clean" would pass vacuously
// even if picking silently failed and no outline rendered.
const EDGE_THRESHOLD = 40;
const cleanTop = (wrapStats.topRows ?? 0) < EDGE_THRESHOLD;
const cleanBot = (wrapStats.botRows ?? 0) < EDGE_THRESHOLD;
const outlineDrawn = (wrapStats.totalOrange ?? 0) > 50;

console.log('\n===== RESULT =====');
console.log(`outline drawn somewhere (sanity):       ${outlineDrawn ? 'PASS ✓' : `FAIL ✗ (only ${wrapStats.totalOrange} orange pixels total)`}`);
console.log(`top edge clean (no wrapped outline):    ${cleanTop ? 'PASS ✓' : `FAIL ✗ (${wrapStats.topRows} orange pixels)`}`);
console.log(`bottom edge clean (no wrapped outline): ${cleanBot ? 'PASS ✓' : `FAIL ✗ (${wrapStats.botRows} orange pixels)`}`);
console.log(`console clean:                          ${errors.length === 0 ? 'PASS ✓' : 'FAIL ✗'}`);

const ok = outlineDrawn && cleanTop && cleanBot && errors.length === 0;
console.log(ok ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
process.exit(ok ? 0 : 1);
