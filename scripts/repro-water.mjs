// Water material smoke test. Loads the multi-layer-terrain demo
// (which now appends a water/plane at water_level=10 over a carved
// 200×200 m eroded heightfield) and asserts:
//   1. No page or WebGPU validation errors — covers the new water
//      material kind's pipeline compile, the bumped scene uniform
//      buffer size, scene-merge propagating terrain[] alongside
//      entities[], etc.
//   2. The Preview shows a meaningful chunk of WATER-coloured pixels
//      (deep blue/teal, distinct from sky's pale teal-grey). This
//      catches a silently culled water plane (winding bug → no
//      visible blue) or a black-water shader (lighting bug → blue
//      missing).

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
    console.log('[gpu]', m.text());
  }
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await page.evaluate(() => {
  const wait = () => {
    const st = window.__sedonStore__.getState();
    if (st.device) {
      st.device.onuncapturederror = (ev) => console.error('WEBGPU:', ev.error.message);
    } else setTimeout(wait, 50);
  };
  wait();
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
await new Promise((r) => setTimeout(r, 5500));

const rect = await page.evaluate(() => {
  const el = document.querySelector('.sedon-panel--preview canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
});
const png = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
  path: '/tmp/repro-water-shot.png',
});
console.log('screenshot bytes:', png.length);
const stats = await page.evaluate(async (b64) => {
  const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const off = new OffscreenCanvas(bmp.width, bmp.height);
  off.getContext('2d').drawImage(bmp, 0, 0);
  const data = off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  // Classify each pixel:
  //   • water: blue-dominant + low-ish brightness (sets it apart from sky)
  //   • terrain: red/pink (layer-0 albedo blend)
  //   • sky: pale teal-grey
  let water = 0, terrain = 0, sky = 0, other = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (b > r + 20 && b > g - 10) {
      water++;
    } else if (r > g + 15) {
      terrain++;
    } else if (r > 150 && g > 150 && b > 150 && Math.abs(r - g) < 30) {
      sky++;
    } else {
      other++;
    }
  }
  return { w: bmp.width, h: bmp.height, water, terrain, sky, other };
}, Buffer.from(png).toString('base64'));
console.log('pixel stats:', stats);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const noGpuErrors = webgpuErrors.length === 0;
// Water at level 10 floods the carved river bed + the lowest
// natural valleys after erosion. The visible fraction depends on
// where the rng-driven perlin lands the lows, but 0.5% of the frame
// is well above the "back-face culled, zero pixels" failure mode and
// safely below the most-flooded extreme.
const waterVisible = stats.water > stats.w * stats.h * 0.005;
const terrainVisible = stats.terrain > stats.w * stats.h * 0.05;

console.log(`no page errors:                       ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length})`);
console.log(`no WebGPU validation errors:          ${noGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${webgpuErrors.length})`);
console.log(`water visible (>0.5% of frame):       ${waterVisible ? 'PASS ✓' : 'FAIL ✗'} (${stats.water} blue px)`);
console.log(`terrain still rendering:              ${terrainVisible ? 'PASS ✓' : 'FAIL ✗'} (${stats.terrain} red px)`);

const ok = noPageErrors && noGpuErrors && waterVisible && terrainVisible;
process.exit(ok ? 0 : 1);
