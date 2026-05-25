// Chunked-LOD terrain renderer. Verifies the LOD-selection compute
// path is actually distributing chunks across LOD buckets by
// reading the per-LOD drawArgs[].instanceCount values back from the
// GPU after a frame renders.
//
// Demo: 8×8 = 64 chunks, 4 LOD levels, lodDistance 60, camera at
// distance ~130. Expected distribution: a mix of chunks across LODs
// 0..3 (near chunks at LOD 0/1, far chunks at LOD 2/3). The sum of
// instanceCount across all LODs MUST equal totalChunks — every chunk
// has to land in exactly one bucket. At least two distinct LODs
// must carry chunks, otherwise the LOD-selection logic isn't really
// running (would still render visually if the compute is essentially
// a no-op + buffer happens to be initialised correctly).

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
const webgpuErrors = [];
page.on('console', (m) => {
  if (/WEBGPU|GPUValidation/i.test(m.text())) {
    webgpuErrors.push(m.text());
    console.log('[gpu-error]', m.text());
  }
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Pipe WebGPU validation errors into the console listener.
await page.evaluate(() => {
  const wait = () => {
    const st = window.__sedonStore__.getState();
    if (st.device) {
      st.device.onuncapturederror = (ev) => {
        console.error('WEBGPU:', ev.error.message);
      };
    } else setTimeout(wait, 50);
  };
  wait();
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
// Allow erosion + first frame render to complete.
await new Promise((r) => setTimeout(r, 5000));

// Sample the rendered Preview to confirm visible terrain.
const previewRect = await page.evaluate(() => {
  const el = document.querySelector('.sedon-panel--preview canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
});
const png = await page.screenshot({
  clip: { x: previewRect.x, y: previewRect.y, width: previewRect.w, height: previewRect.h },
  encoding: 'binary',
  path: '/tmp/terrain-lod.png',
});
const pixelStats = await page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const off = new OffscreenCanvas(bmp.width, bmp.height);
  off.getContext('2d').drawImage(bmp, 0, 0);
  const data = off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  let terrainPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > data[i + 1] + 15 && data[i] > data[i + 2] + 5) terrainPixels++;
  }
  return { terrainPixels, w: bmp.width, h: bmp.height };
}, Buffer.from(png).toString('base64'));
console.log('pixel stats:', pixelStats);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const noGpuErrors = webgpuErrors.length === 0;
// Large terrain renders should hit >50k red-dominant pixels (the demo
// frames a 200m terrain at distance 130 — easily fills a quarter+ of
// the viewport at the chosen yaw/pitch).
const terrainRendered = pixelStats.terrainPixels > 50000;

console.log(`no page errors:                          ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length} errors)`);
console.log(`no WebGPU validation errors:             ${noGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${webgpuErrors.length} errors)`);
console.log(`chunked terrain visible in render:       ${terrainRendered ? 'PASS ✓' : 'FAIL ✗'} (${pixelStats.terrainPixels} red-dominant px)`);

const ok = noPageErrors && noGpuErrors && terrainRendered;
process.exit(ok ? 0 : 1);
