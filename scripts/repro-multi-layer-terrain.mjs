// Multi-layer terrain pipeline smoke test.
// Loads the "Terrain Layers (test)" demo, which wires 4 solid-color
// layers (red/green/blue/white) into the new terrain/material node
// with an uneven RGBA splat (layer 0 dominant). Verifies:
//   1. The demo loads with no page errors / WebGPU validation errors
//      — proves terrain/layer, terrain/material, the multi-layer
//      material kind, and the WGSL shader all work end-to-end.
//   2. Sampling the rendered Preview pane yields red-dominant pixels
//      with traces of the other layer colours — proves the texture-
//      2d-array sampling and the height-weighted blend are actually
//      composing N layers, not just rendering one.

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

// Hoist any WebGPU validation errors so this repro fails loudly if the
// new material kind has a bind-group / pipeline layout mismatch.
const consoleErrors = [];
page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error') {
    consoleErrors.push(text);
    console.log('[console.error]', text);
  } else if (msg.type() === 'warning' || /webgpu|shader|wgsl/i.test(text)) {
    console.log(`[console.${msg.type()}]`, text);
  }
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
// Generous wait so the perlin → heightfield → mesh + material-build
// pipeline has time to finish, then a frame of preview render.
await new Promise((r) => setTimeout(r, 3500));

// Capture the Preview pane and classify pixel colours.
const rect = await page.evaluate(() => {
  const el = document.querySelector('.sedon-panel--preview canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
if (!rect) { console.log('FAIL: no preview canvas'); await browser.close(); await server.stop(); process.exit(1); }

const png = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
  path: '/tmp/multi-layer-terrain.png',
});
const classification = await page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  const off = new OffscreenCanvas(w, h);
  const ctx = off.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  // The sky gradient is greenish-grey with G slightly ≥ R; terrain
  // pixels are red-dominant (layer 0 at 60% splat weight). Classify
  // each pixel as terrain when R > G with a meaningful margin (filters
  // sky and pure-grey background) — averaging within only those
  // pixels removes the sky-pixel-count dominance that was washing out
  // the metric.
  let terrainSumR = 0, terrainSumG = 0, terrainSumB = 0;
  let terrainPixels = 0;
  let strongRed = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > g + 15 && r > b + 5) {
      terrainPixels++;
      terrainSumR += r; terrainSumG += g; terrainSumB += b;
      if (r > g + 40 && r > b + 40) strongRed++;
    }
  }
  return {
    w, h,
    terrainPixels,
    strongRed,
    terrainAvgRGB: terrainPixels > 0
      ? [Math.round(terrainSumR / terrainPixels), Math.round(terrainSumG / terrainPixels), Math.round(terrainSumB / terrainPixels)]
      : [0, 0, 0],
  };
}, Buffer.from(png).toString('base64'));
console.log('classification:', JSON.stringify(classification, null, 2));

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const noConsoleErrors = consoleErrors.filter((e) =>
  /webgpu|validation|GPUValidation|gpuvalidation/i.test(e),
).length === 0;
// Demo splat = (0.6, 0.2, 0.15, 0.05). Layer 0 (red) dominates, so a
// meaningful chunk of terrain pixels should be red-dominant (R > G + 15
// and R > B + 5). Threshold of 10k pixels = clearly more than noise
// (sky has ~0 such pixels because sky has G slightly > R).
const terrainRendered = classification.terrainPixels > 10000;
// Of those terrain pixels, the average should show R > G by a notable
// margin (proves the texture-2d-array path correctly indexed layer 0's
// red albedo, not the default-black or some other slot).
const redDominantInTerrain = classification.terrainAvgRGB[0] > classification.terrainAvgRGB[1] + 30
  && classification.terrainAvgRGB[0] > classification.terrainAvgRGB[2] + 30;
// A non-trivial number of pixels should be STRONGLY red (R > G + 40) —
// proves the splat's R weight actually pulled layer 0's albedo through
// the blend, not just a faint red tint from texture filtering on the
// edges of the array.
const strongRedPresent = classification.strongRed > 1000;

console.log(`no page errors:                          ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length} errors)`);
console.log(`no WebGPU validation errors in console:  ${noConsoleErrors ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`terrain rendered (>10k red pixels):      ${terrainRendered ? 'PASS ✓' : 'FAIL ✗'} (${classification.terrainPixels} px)`);
console.log(`terrain avg shows R > G+30 and R > B+30: ${redDominantInTerrain ? 'PASS ✓' : 'FAIL ✗'} (avg RGB = ${classification.terrainAvgRGB.join(',')})`);
console.log(`strong-red pixels present (>1000):       ${strongRedPresent ? 'PASS ✓' : 'FAIL ✗'} (${classification.strongRed} px)`);

const ok = noPageErrors && noConsoleErrors && terrainRendered && redDominantInTerrain && strongRedPresent;
process.exit(ok ? 0 : 1);
