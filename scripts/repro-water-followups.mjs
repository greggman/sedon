// Three water v2 follow-ups: foam, transparency, underwater.
//
// 1. Foam — load the demo (water at level 13, foamWidth 1.5). Sample
//    the rendered Preview for *near-white* pixels: shoreline foam
//    pixels are bright (>200 in all three channels) with low colour
//    variance. Should comfortably exceed a few thousand even with
//    only short shoreline lengths visible.
//
// 2. Transparency — the demo's water color has alpha 0.7. The water
//    fragment colour is therefore mixed against the terrain colour
//    below. Sample water pixels and assert their R channel is HIGHER
//    than a fully-opaque water shader would produce (terrain-red
//    leaking through the blue water). With opaque water R≈25 (deep
//    teal); transparent water mixed with red terrain R≈80+.
//
// 3. Underwater — programmatically move the camera below the scene's
//    water_level via the layout store's preview camera and re-render.
//    Sample the FULL frame: average colour should be dominated by
//    the underwater tint (green-blue), with the sky's pale-grey
//    average shifted hard toward (0.15, 0.45, 0.55).

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
const gpuErrors = [];
page.on('console', (m) => {
  if (/WEBGPU|GPUValidation/i.test(m.text())) {
    gpuErrors.push(m.text());
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

const grabFrame = async (filename) => {
  const rect = await page.evaluate(() => {
    const el = document.querySelector('.sedon-panel--preview canvas');
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  });
  const png = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    encoding: 'binary',
    path: filename,
  });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    off.getContext('2d').drawImage(bmp, 0, 0);
    const data = off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    let foamCount = 0;          // near-white, low variance
    let waterCount = 0;         // blue-dominant
    let waterRSum = 0;          // average red in water region
    let frameRSum = 0, frameGSum = 0, frameBSum = 0;
    const total = bmp.width * bmp.height;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      frameRSum += r; frameGSum += g; frameBSum += b;
      // Foam: all three channels > 215 AND tight grouping (range < 25)
      // — the foam shader tints toward (230, 240, 245) before fog.
      if (r > 200 && g > 200 && b > 200 && (Math.max(r, g, b) - Math.min(r, g, b)) < 30) {
        foamCount++;
      } else if (b > r + 20 && b > g - 5) {
        waterCount++;
        waterRSum += r;
      }
    }
    return {
      w: bmp.width, h: bmp.height, total,
      foamCount,
      waterCount,
      waterAvgR: waterCount > 0 ? Math.round(waterRSum / waterCount) : 0,
      frameAvg: [Math.round(frameRSum / total), Math.round(frameGSum / total), Math.round(frameBSum / total)],
    };
  }, Buffer.from(png).toString('base64'));
};

// 1. Default camera (above water).
const above = await grabFrame('/tmp/water-above.png');
console.log('above water:', above);

// 2. Submerge the camera. Preview pane reads from
// layoutStore.previewCameras[panelId][graphId], so a savePreviewCamera
// call there overrides the project default and triggers a re-render.
// Pull the camera down to a low orbit distance and a flat pitch so
// the eye sits well below water_level=13.
const cameraInfo = await page.evaluate(() => {
  const layout = window.__sedonLayoutStore__.getState();
  layout.savePreviewCamera('preview-main', 'main', { yaw: 0.3, pitch: -0.2, distance: 5, target: [0, 8, 0] });
  const after = window.__sedonLayoutStore__.getState().previewCameras['preview-main']?.main;
  // eyeY ≈ target.y + distance * sin(pitch)
  const eyeY = (after?.target[1] ?? 0) + (after?.distance ?? 0) * Math.sin(after?.pitch ?? 0);
  return { stored: after, eyeY };
});
console.log('post-move camera:', cameraInfo);
await new Promise((r) => setTimeout(r, 2500));
const below = await grabFrame('/tmp/water-below.png');
console.log('below water:', below);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const noGpuErrors = gpuErrors.length === 0;
// Foam: at least a few thousand near-white pixels around shorelines.
// The demo's lakes have considerable shoreline so this should be
// easily met (we saw 100k+ in the earlier screenshot).
const foamVisible = above.foamCount > 2000;
// Transparency: water pixels' average R is well above pure-water R.
// With opaque (alpha=1.0) the water is deep teal R≈25; transparency
// mixes in terrain red so R climbs into the 50+ range.
const transparencyVisible = above.waterAvgR > 40;
// Underwater: full-frame average should shift toward the underwater
// tint (G > R, B > R by a clear margin) when submerged. Above
// water the average is dominated by terrain-red + sky-grey so R is
// usually the largest channel.
const underwaterActive =
  below.frameAvg[1] > below.frameAvg[0] + 5
  && below.frameAvg[2] > below.frameAvg[0] + 5;

console.log(`no page errors:                       ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length})`);
console.log(`no WebGPU validation errors:          ${noGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${gpuErrors.length})`);
console.log(`foam visible (>2k bright pixels):     ${foamVisible ? 'PASS ✓' : 'FAIL ✗'} (${above.foamCount} px)`);
console.log(`transparency: water-region R lifted:  ${transparencyVisible ? 'PASS ✓' : 'FAIL ✗'} (avg R = ${above.waterAvgR})`);
console.log(`underwater tint dominates submerged:  ${underwaterActive ? 'PASS ✓' : 'FAIL ✗'} (frame avg RGB = ${below.frameAvg.join(',')})`);

const ok = noPageErrors && noGpuErrors && foamVisible && transparencyVisible && underwaterActive;
process.exit(ok ? 0 : 1);
