// Path carve verification. Loads the multi-layer-terrain demo (which
// chains perlin → heightfield → erosion → path/carve-heightfield →
// terrain/renderer) and proves that the carve actually modifies the
// heightfield where the path runs and only there.
//
// Strategy: read the eroded heightfield (pre-carve) and the carved
// heightfield (post-carve) textures back to CPU via a staging buffer
// copy. Then for each path sample world-XZ, find the corresponding
// texel and assert the carved texel is meaningfully LOWER than the
// pre-carve one. Conversely, sample a few "off-path" coordinates and
// assert no change.
//
// Catches: a no-op carve (depth=0 effectively), a wrong-coords carve
// (shifts the trench off the path), an inverted carve (raises
// instead of lowers).

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
await new Promise((r) => setTimeout(r, 5000));

// Read both heightfield textures (pre-carve = erosion output,
// post-carve = path/carve output). Find them via the eval cache + a
// staging-buffer readback in the page.
const measurement = await page.evaluate(async () => {
  const st = window.__sedonStore__.getState();
  const cache = st.evalCache;
  const find = (kind) => {
    const node = st.graph.nodes.find((n) => n.kind === kind);
    if (!node) return null;
    const fp = cache.lastFingerprintByNodeId.get(node.id);
    return fp ? cache.entries.get(fp) : null;
  };
  const erosionEntry = find('terrain/hydraulic-erosion');
  const carveEntry = find('path/carve-heightfield');
  const pathEntry = find('path/spline');
  if (!erosionEntry || !carveEntry || !pathEntry) {
    return { error: `missing cache entries: erosion=${!!erosionEntry} carve=${!!carveEntry} path=${!!pathEntry}` };
  }
  const erodedField = erosionEntry.heightfield;
  const carvedField = carveEntry.heightfield;
  if (!erodedField || !carvedField) return { error: 'missing heightfield outputs' };

  const device = st.device;
  const w = erodedField.texture.width;
  const h = erodedField.texture.height;

  // Readback helper: copyTextureToBuffer → map → return R-channel
  // floats. bytesPerRow must be a multiple of 256.
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const readback = async (tex) => {
    const staging = device.createBuffer({
      size: bytesPerRow * h,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex.texture },
      { buffer: staging, bytesPerRow, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(staging.getMappedRange()).slice();
    staging.unmap();
    staging.destroy();
    const r = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * bytesPerRow;
      for (let x = 0; x < w; x++) {
        r[y * w + x] = bytes[row + x * 4] / 255;
      }
    }
    return r;
  };
  const before = await readback(erodedField.texture);
  const after = await readback(carvedField.texture);

  // World ↔ UV: heightfield centered at origin, spans
  // [-worldSize/2, +worldSize/2]. Same convention as
  // terrain-render.wgsl + path-carve-heightfield.wgsl.
  const worldSize = erodedField.worldSize;
  const worldToTexel = (wx, wz) => {
    const u = wx / worldSize[0] + 0.5;
    const v = wz / worldSize[1] + 0.5;
    const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const y = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
    return y * w + x;
  };

  // ON-PATH samples: every Nth point along the path's polyline.
  const pathSamples = pathEntry.path.samples;
  const pathCount = pathEntry.path.count;
  let onPathDrops = 0;
  let onPathTotal = 0;
  for (let i = 0; i < pathCount; i += Math.max(1, Math.floor(pathCount / 16))) {
    const wx = pathSamples[i * 3];
    const wz = pathSamples[i * 3 + 2];
    const idx = worldToTexel(wx, wz);
    const drop = before[idx] - after[idx];
    if (drop > 0.02) onPathDrops++;  // > ~0.6m on a 30m range
    onPathTotal++;
  }

  // OFF-PATH samples: chosen far from any path segment. The demo
  // path runs roughly along the -X,-Z → +X,+Z diagonal with a
  // meander; samples here are on the OPPOSITE diagonal so they
  // shouldn't be touched by the carve.
  const offPoints = [
    [+90, -90],  // opposite corner from path start (-90,-90)
    [-90, +90],  // opposite corner from path end (+90,+90)
    [+60, -60], [-60, +60],
    [+95, -30], [-95, +30],
    [+30, -95], [-30, +95],
  ];
  let offChanges = 0;
  let offMaxDrop = 0;
  for (const [wx, wz] of offPoints) {
    const idx = worldToTexel(wx, wz);
    const drop = before[idx] - after[idx];
    offMaxDrop = Math.max(offMaxDrop, Math.abs(drop));
    if (Math.abs(drop) > 0.005) offChanges++;
  }

  return {
    width: w,
    height: h,
    worldSize,
    onPathDrops,
    onPathTotal,
    offChanges,
    offMaxDrop,
  };
});
console.log('measurement:', JSON.stringify(measurement, null, 2));

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
if (measurement.error) {
  console.log('FAIL:', measurement.error);
  process.exit(1);
}
const noPageErrors = pageErrors.length === 0;
const noGpuErrors = webgpuErrors.length === 0;
// Most on-path samples should show a meaningful drop (the path is
// straight-ish so 12/16+ checking with a tolerance for samples that
// happen to land in already-eroded valleys).
const onPathCarved = measurement.onPathDrops >= Math.floor(measurement.onPathTotal * 0.6);
// Off-path corners must NOT have moved meaningfully — proves the
// carve didn't bleed into the whole texture.
const offPathUntouched = measurement.offChanges === 0;

console.log(`no page errors:                          ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length})`);
console.log(`no WebGPU validation errors:             ${noGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${webgpuErrors.length})`);
console.log(`on-path samples got carved down:         ${onPathCarved ? 'PASS ✓' : 'FAIL ✗'} (${measurement.onPathDrops}/${measurement.onPathTotal} samples dropped > 0.02)`);
console.log(`off-path samples unchanged:              ${offPathUntouched ? 'PASS ✓' : 'FAIL ✗'} (${measurement.offChanges}/8 changed, max drop = ${measurement.offMaxDrop.toFixed(4)})`);

const ok = noPageErrors && noGpuErrors && onPathCarved && offPathUntouched;
process.exit(ok ? 0 : 1);
