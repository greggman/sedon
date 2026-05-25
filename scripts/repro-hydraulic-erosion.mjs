// Hydraulic erosion smoke test. Loads the "Terrain Layers (test)"
// demo (which chains perlin → heightfield → terrain/hydraulic-erosion
// → heightfield-to-mesh) and verifies the erosion node ACTUALLY did
// something — its in-canvas preview must differ measurably from the
// upstream perlin's preview.
//
// Without this guard a no-op erosion (e.g. simulate pass dispatched 0
// workgroups, atomic ops on an unreachable buffer, etc.) would pass
// the existing multi-layer repro because the rendered terrain still
// has the multi-layer colour.

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
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Hook WebGPU validation errors so they fail loudly.
const webgpuErrors = [];
await page.evaluateOnNewDocument(() => {
  // Patch onuncapturederror as soon as the device becomes available.
  const poll = setInterval(() => {
    const st = window.__sedonStore__?.getState?.();
    if (st?.device) {
      st.device.onuncapturederror = (ev) => {
        console.error('WEBGPU_VALIDATION_ERROR:', ev.error.message);
      };
      clearInterval(poll);
    }
  }, 50);
});
page.on('console', (msg) => {
  if (msg.text().includes('WEBGPU_VALIDATION_ERROR')) {
    webgpuErrors.push(msg.text());
    console.log('[' + msg.text() + ']');
  }
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
await new Promise((r) => setTimeout(r, 3500));

// Find the perlin node's and the erosion node's preview canvases.
const previewCanvases = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const perlin = st.graph.nodes.find((n) => n.kind === 'core/perlin');
  const erosion = st.graph.nodes.find((n) => n.kind === 'terrain/hydraulic-erosion');
  if (!perlin || !erosion) return { error: `missing nodes (perlin=${!!perlin}, erosion=${!!erosion})` };
  const lookup = (id) => {
    const nodeEl = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    if (!nodeEl) return null;
    const c = nodeEl.querySelector('canvas.sedon-texture-preview');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  return {
    perlin: lookup(perlin.id),
    erosion: lookup(erosion.id),
  };
});
if (previewCanvases.error || !previewCanvases.perlin || !previewCanvases.erosion) {
  console.log('FAIL: could not find preview canvases:', previewCanvases);
  await browser.close();
  await server.stop();
  process.exit(1);
}
console.log('preview rects:', previewCanvases);

// Screenshot both previews.
const shot = async (rect) => {
  if (rect.w < 4 || rect.h < 4) return null;
  const png = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    encoding: 'binary',
  });
  return Buffer.from(png).toString('base64');
};
const perlinB64 = await shot(previewCanvases.perlin);
const erosionB64 = await shot(previewCanvases.erosion);
if (!perlinB64 || !erosionB64) {
  console.log('FAIL: preview canvases too small to screenshot (zoom out and re-run?)');
  await browser.close();
  await server.stop();
  process.exit(1);
}

// Decode both, compare pixel grids. Identical heightfields = identical
// previews; eroded ones have measurable per-pixel differences.
const compared = await page.evaluate(async (a, b) => {
  const decode = async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  };
  const A = await decode(a);
  const B = await decode(b);
  if (A.w !== B.w || A.h !== B.h) {
    return { differentSize: true, A: { w: A.w, h: A.h }, B: { w: B.w, h: B.h } };
  }
  // Per-pixel R-channel mean absolute difference (heightfield previews
  // render greyscale, so R is enough). Plus the FRACTION of pixels
  // that differ by more than 5 grey levels — distinguishes "tiny
  // sampling jitter" (very low MAE, very low diff fraction) from
  // "real erosion" (moderate MAE, large diff fraction).
  let sum = 0, diffPx = 0, total = 0;
  for (let i = 0; i < A.data.length; i += 4) {
    const da = Math.abs(A.data[i] - B.data[i]);
    sum += da;
    if (da > 5) diffPx++;
    total++;
  }
  return {
    w: A.w, h: A.h,
    meanAbsDiff: sum / total,
    diffPixelFraction: diffPx / total,
  };
}, perlinB64, erosionB64);
console.log('comparison:', compared);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const noWebGpuErrors = webgpuErrors.length === 0;
// Mean abs diff > 5 (out of 255) — erosion modified the heightfield
// non-trivially. Diff-pixel fraction > 10% — change is spatially
// widespread, not a stray artefact.
const erosionVisible = (compared.meanAbsDiff ?? 0) > 5
  && (compared.diffPixelFraction ?? 0) > 0.1;

console.log(`no page errors:                          ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length} errors)`);
console.log(`no WebGPU validation errors:             ${noWebGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${webgpuErrors.length} errors)`);
console.log(`erosion modifies the heightfield:        ${erosionVisible ? 'PASS ✓' : 'FAIL ✗'} (mean-abs-diff=${(compared.meanAbsDiff ?? 0).toFixed(2)}/255; ${((compared.diffPixelFraction ?? 0) * 100).toFixed(1)}% pixels differ by >5)`);

const ok = noPageErrors && noWebGpuErrors && erosionVisible;
process.exit(ok ? 0 : 1);
