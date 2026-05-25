// Leaf-skeleton 2-channel preview composite.
// Verifies that the in-node preview for `leaf/skeleton` shows BOTH the
// shape silhouette AND the veins, using the app-accent palette:
//   • dark bg (#1a1a1f)
//   • off-white shape (#e8e8e8)
//   • warm orange veins (#ffa526)
//
// We sample many pixels from the preview canvas, classify each as bg /
// shape / vein based on proximity to the target colors, and assert all
// three are present in non-trivial amounts. Before the fix the canvas
// only contained black (preview-canvas clear) + white (silhouette);
// orange must appear for this to pass.

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
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Load the leaf demo, then switch the editing context to the oak-leaf
// subgraph — that's where the leaf/skeleton node actually lives.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'leaf');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 600));
await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const oakLeaf = state.subgraphs.find((s) => s.id === 'oak-leaf');
  if (oakLeaf) state.setActiveEditing(oakLeaf.id);
});
await new Promise((r) => setTimeout(r, 1500));
// Click the leaf/skeleton node so it ends up selected, then Frame
// Selected (F) zooms the canvas in on just that node so its preview
// is large enough that 1-px-wide vein strokes register as a meaningful
// pixel fraction. Without this, frame-all leaves the preview at ~44px
// where the vein AA washes into the shape color.
const nodeCenter = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const skeleton = state.graph.nodes.find((n) => n.kind === 'leaf/skeleton');
  if (!skeleton) return null;
  const el = document.querySelector(`.react-flow__node[data-id="${skeleton.id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Click on the header area so we hit the node, not the preview
  // canvas (which intercepts pointer events differently).
  return { x: r.left + r.width / 2, y: r.top + 16 };
});
await page.mouse.click(nodeCenter.x, nodeCenter.y);
await new Promise((r) => setTimeout(r, 200));
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 1200));

// Locate the leaf/skeleton node's preview canvas in the page.
const rect = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const skeleton = state.graph.nodes.find((n) => n.kind === 'leaf/skeleton');
  if (!skeleton) return { error: 'no leaf/skeleton node in active graph' };
  const nodeEl = document.querySelector(`.react-flow__node[data-id="${skeleton.id}"]`);
  if (!nodeEl) return { error: 'no DOM node for leaf/skeleton' };
  const canvas = nodeEl.querySelector('canvas.sedon-texture-preview');
  if (!canvas) return { error: 'no preview canvas inside leaf/skeleton node' };
  const r = canvas.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
if (rect.error) {
  console.log('FAIL:', rect.error);
  await browser.close();
  await server.stop();
  process.exit(1);
}

// Screenshot the canvas region. Puppeteer's screenshot reads the actual
// composited frame, which works reliably for WebGPU canvases where
// drawImage(canvas) might return blank in headless contexts.
const png = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
});

// Decode the PNG using a quick inline parser via the browser. Faster
// than importing a node png library: send the buffer back into the
// page, decode via Image + canvas, return pixel counts.
const sample = await page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const targets = {
    bg:    [0x1a, 0x1a, 0x1f],
    shape: [0x7c, 0x7c, 0x7c],
    vein:  [0xff, 0xa5, 0x26],
  };
  const dist = (r, g, b, t) => Math.hypot(r - t[0], g - t[1], b - t[2]);
  const counts = { bg: 0, shape: 0, vein: 0, other: 0 };
  const total = w * h;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const dBg = dist(r, g, b, targets.bg);
    const dShape = dist(r, g, b, targets.shape);
    const dVein = dist(r, g, b, targets.vein);
    // Assign each pixel to the nearest target color. No "other" bucket
    // — the mid-grey shape is close in distance to the dark bg, so a
    // strict cutoff loses too many AA pixels along the leaf edge.
    const min = Math.min(dBg, dShape, dVein);
    if (min === dBg) counts.bg++;
    else if (min === dShape) counts.shape++;
    else counts.vein++;
  }
  return {
    w, h, total,
    bgPct: counts.bg / total,
    shapePct: counts.shape / total,
    veinPct: counts.vein / total,
    otherPct: counts.other / total,
  };
}, Buffer.from(png).toString('base64'));
console.log('pixel classification:', sample);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
if (sample.error) {
  console.log('FAIL:', sample.error);
  process.exit(1);
}
// Thresholds: each category should be more than a trivial sliver. Veins
// are the thinnest, so the bar is the lowest there.
const hasBg = sample.bgPct > 0.05;
const hasShape = sample.shapePct > 0.1;
const hasVein = sample.veinPct > 0.005;
console.log(`background pixels present (>5%):    ${hasBg    ? 'PASS ✓' : 'FAIL ✗'} (${(sample.bgPct*100).toFixed(1)}%)`);
console.log(`off-white shape present (>10%):     ${hasShape ? 'PASS ✓' : 'FAIL ✗'} (${(sample.shapePct*100).toFixed(1)}%)`);
console.log(`orange vein pixels present (>0.5%): ${hasVein  ? 'PASS ✓' : 'FAIL ✗'} (${(sample.veinPct*100).toFixed(1)}%)`);

process.exit(hasBg && hasShape && hasVein ? 0 : 1);
