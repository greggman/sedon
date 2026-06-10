// Read back the erosion node's output texture and report its actual
// min/max + a few sample values, plus the same for the upstream
// texture-map-range output. Distinguishes "fixed-point overflow"
// (extreme outliers stretching auto-level) from "algorithm genuinely
// flattens" (output values really do cluster near the mean).

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[page]', msg.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1&scene=multi-layer-terrain`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
// Give erosion + preview a few seconds to run.
await new Promise((r) => setTimeout(r, 4000));

const stats = await page.evaluate(async () => {
  // Locate the relevant nodes in the active graph, then read back each
  // node's eval-output texture via the debug-mode getter that mirrors
  // the canvas-data store the editor uses.
  const state = window.__sedonStore__.getState();
  const device = state.device;
  const graph = state.mainGraph;
  if (!device || !graph) return { error: 'no device/graph' };

  // Pick the first panel that has any outputs (there will be one per
  // open canvas; for the default editor layout that's the main canvas).
  const panelId = window.__sedonListPanelIds__()[0];
  if (!panelId) return { error: 'no panel with outputs' };

  const erosionNode = graph.nodes.find((n) => n.kind === 'terrain/hydraulic-erosion');
  const mapRangeNode = graph.nodes.find((n) => n.kind === 'tex/map-range');

  async function readbackR(tex) {
    const w = tex.width, h = tex.height;
    const bpr = Math.ceil((w * 8) / 256) * 256; // rgba16float = 8 bytes/pixel
    const buf = device.createBuffer({
      size: bpr * h,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: tex.texture },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    );
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buf.getMappedRange().slice(0));
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    buf.unmap();
    buf.destroy();
    // Decode half-floats to f32; only R channel (every 4th u16, starting offset 0).
    const halfToFloat = (h16) => {
      const s = (h16 & 0x8000) >> 15;
      const e = (h16 & 0x7C00) >> 10;
      const f = h16 & 0x03FF;
      if (e === 0) return s ? -1 * Math.pow(2, -14) * (f / 1024) : Math.pow(2, -14) * (f / 1024);
      if (e === 0x1F) return f ? NaN : (s ? -Infinity : Infinity);
      return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    };
    const reds = new Float32Array(w * h);
    const u16PerRow = bpr >> 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        reds[y * w + x] = halfToFloat(u16[y * u16PerRow + x * 4]);
      }
    }
    return reds;
  }

  function summary(arr) {
    let lo = Infinity, hi = -Infinity, sum = 0, finite = 0, nan = 0, inf = 0;
    const bins = new Array(20).fill(0);
    for (const v of arr) {
      if (Number.isNaN(v)) { nan++; continue; }
      if (!Number.isFinite(v)) { inf++; continue; }
      finite++;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    const mean = sum / finite;
    // Histogram of finite values across [lo, hi].
    const span = hi - lo || 1;
    for (const v of arr) {
      if (!Number.isFinite(v)) continue;
      const b = Math.min(19, Math.floor((v - lo) / span * 20));
      bins[b]++;
    }
    return { lo, hi, mean, nan, inf, finite, bins };
  }

  const results = { panelId };
  for (const [label, node] of [['mapRange', mapRangeNode], ['erosion', erosionNode]]) {
    if (!node) { results[label] = 'no node'; continue; }
    const out = window.__sedonGetOutputs__(panelId, node.id);
    if (!out || !out.texture) { results[label] = 'no output'; continue; }
    const reds = await readbackR(out.texture);
    results[label] = summary(reds);
  }
  return results;
});

console.log(JSON.stringify(stats, null, 2));

await browser.close();
await server.stop();
