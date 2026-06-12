// Regression: (1) editing grass-blades colours must update the preview
// (the card array is a one-time copy of a REUSED texture, so it must
// re-blit on content change), and (2) lowering geom/grass spacing must
// not throw WebGPU errors (the instance-buffer growth path used to leave
// the compute/render bind groups null).

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
const gpuErrors = [];
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => {
  const t = msg.text();
  if (/webgpu|validation|bind group|setBindGroup|destroyed|invalid/i.test(t)) gpuErrors.push(t);
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Capture uncaptured GPU validation errors directly from the device.
await page.evaluate(() => {
  globalThis.__gpuErr = [];
  const hook = () => {
    const dev = window.__sedonStore__.getState().device;
    if (dev && !dev.__hooked) {
      dev.__hooked = true;
      dev.addEventListener('uncapturederror', (e) => globalThis.__gpuErr.push(String(e.error.message)));
    }
    requestAnimationFrame(hook);
  };
  hook();
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));

const findNode = (kind) => page.evaluate((k) => {
  const all = [
    ...window.__sedonStore__.getState().mainGraph.nodes,
    ...window.__sedonStore__.getState().subgraphs.flatMap((s) => s.graph.nodes),
  ];
  return all.find((n) => n.kind === k)?.id ?? null;
}, kind);

const bladesId = await findNode('geom/grass-blades');
const grassId = await findNode('geom/grass');
console.log('grass-blades:', bladesId, ' geom/grass:', grassId);

// Card-array blit counter (exposed under ?debug=1). A WebGPU canvas can't
// be pixel-diffed via toDataURL (swap chain isn't preserved), so we assert
// the card array gets re-copied instead — that's exactly what was missing.
const blits = () => page.evaluate(() => window.__sedonGrassBlits__?.() ?? 0);

// ---- Issue 1: edit grass-blades tipColor, expect a re-blit (the new
// colour reaches the screen only if the card array is re-copied). ----
const blitsBefore = await blits();
await page.evaluate((id) => {
  window.__sedonStore__.getState().setInputValue(id, 'tipColor', [0.9, 0.2, 0.7, 1]);
}, bladesId);
await new Promise((r) => setTimeout(r, 1500));
const blitsAfter = await blits();
const previewChanged = blitsAfter > blitsBefore;
console.log(`\ncard-array blits: ${blitsBefore} → ${blitsAfter}  (must increase)`);

// ---- Issue 2: lower spacing to 0.3, expect NO gpu errors ----
const errBefore = await page.evaluate(() => globalThis.__gpuErr.length);
await page.evaluate((id) => {
  window.__sedonStore__.getState().setInputValue(id, 'spacing', 0.3);
}, grassId);
await new Promise((r) => setTimeout(r, 2000));
const errAfter = await page.evaluate(() => globalThis.__gpuErr.slice());

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const issue1 = previewChanged;
const issue2 = errAfter.length === errBefore && gpuErrors.length === 0;
console.log(`issue 1 (color edit updates preview): ${issue1 ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`issue 2 (spacing 0.3, no errors): ${issue2 ? 'PASS ✓' : 'FAIL ✗'}`);
if (errAfter.length) console.log('GPU errors:', errAfter);
if (gpuErrors.length) console.log('console GPU errors:', gpuErrors.slice(0, 5));
process.exit(issue1 && issue2 ? 0 : 1);
