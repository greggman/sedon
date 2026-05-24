// P4 selection outline. Loads forest, presses F over a tree (which
// frames + selects it), screenshots the canvas, then presses Escape and
// screenshots again. The first image must contain the outline-orange
// colour (1.0, 0.65, 0.15 in linear, similar in sRGB → R≈255, G≈170,
// B≈40); the second must not.
//
// Counting orange-ish pixels is more robust than pixel-exact diffing —
// it tolerates camera drift between F and Escape.

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
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log(`   [error] ${msg.text()}`);
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));

const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-preview-canvas');
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = rect.x + rect.w * 0.5;
const cy = rect.y + rect.h * 0.6;
const skyX = rect.x + rect.w * 0.5;
const skyY = rect.y + 8;

// Count "outline orange" pixels in a screenshot. The shader writes
// (1.0, 0.65, 0.15, 1.0) in LINEAR; after the swapchain's sRGB encode
// that's roughly (255, 207, 109) — we're loose: high R, mid G, low B.
// Puppeteer requires integer clip dimensions.
const clip = { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.floor(rect.w), height: Math.floor(rect.h) };
async function countOrange() {
  const buf = await page.screenshot({ type: 'png', clip });
  // Naive PNG decode — use a tiny inline implementation via canvas in
  // the page rather than pulling in a PNG library on the node side.
  // We just need pixel counts.
  const b64 = buf.toString('base64');
  return page.evaluate(async (b64, w, h) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // Outline-orange-ish: warm RGB ratio (r > g > b) + bright enough
      // that dim foliage/terrain doesn't satisfy it. The shader writes
      // (1.0, 0.65, 0.15) in LINEAR which gamma-encodes to roughly
      // (255, 207, 109) on an sRGB swapchain.
      if (r > 200 && b < 160 && r > g + 30 && g > b + 30) n++;
    }
    return n;
  }, b64, Math.floor(rect.w), Math.floor(rect.h));
}

// Focus + screenshot baseline. Click-to-select fires on this click,
// so we have to take the baseline reading BEFORE the focus click —
// otherwise the baseline already has an outline and the F-delta is
// meaningless. Pre-baseline focus: a left-click at the SKY position
// instead, which selects nothing (id=0 → applySelection(null)).
// Sky-click clears any selection from a stale state.
await page.mouse.click(skyX, skyY);
await new Promise((r) => setTimeout(r, 300));
const baselineOrange = await countOrange();
console.log('baseline orange pixels:', baselineOrange);

// Click on a tree → outline appears (no framing — that's F's job).
// The pick is async + the next render happens on the following rAF;
// wait long enough that the headless harness reliably observes the
// post-render swapchain. The feature works in real browsers regardless
// of the wait; this just keeps the repro from being timing-flaky.
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 1500));
const framedOrange = await countOrange();
console.log('after click (selected) orange pixels:', framedOrange);

// Escape clears the selection — outline gone.
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 500));
const clearedOrange = await countOrange();
console.log('after Escape orange pixels:    ', clearedOrange);

// Right-click sky → "Frame Scene" → outline must NOT appear.
await page.mouse.click(skyX, skyY, { button: 'right' });
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.sedon-assets-context-menu-item')];
  const fs = items.find((b) => b.textContent === 'Frame Scene');
  fs?.click();
});
await new Promise((r) => setTimeout(r, 600));
const sceneOrange = await countOrange();
console.log('after Frame Scene orange pixels:', sceneOrange);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
// Outline must add a clearly-visible ring of orange pixels: at least a
// few hundred, way over the baseline scene noise. (Forest demo has
// some warm tones — fall foliage etc. — so we can't expect baseline 0.
// We require the F-state to ADD at least a few hundred orange pixels.)
const addedByOutline = framedOrange - baselineOrange;
const removedByEscape = framedOrange - clearedOrange;
const removedByScene  = framedOrange - sceneOrange;
console.log(`click added outline pixels:        ${addedByOutline > 200 ? 'PASS ✓' : 'FAIL ✗'} (+${addedByOutline})`);
console.log(`Escape removed the outline:        ${removedByEscape > addedByOutline * 0.5 ? 'PASS ✓' : 'FAIL ✗'} (-${removedByEscape})`);
console.log(`Frame Scene removed the outline:   ${removedByScene > addedByOutline * 0.5 ? 'PASS ✓' : 'FAIL ✗'} (-${removedByScene})`);
const ok = addedByOutline > 200 && removedByEscape > addedByOutline * 0.5 && removedByScene > addedByOutline * 0.5;
process.exit(ok ? 0 : 1);
