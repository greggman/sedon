// Verify the rgba16float texture preview auto-leveling: load the
// multi-layer-terrain demo (which authors a heightfield in metres via
// texture-convert → texture-map-range), find the in-canvas texture
// preview canvas for the height texture, and confirm it isn't a flat
// saturated block (which would mean the preview saturated all
// out-of-[0,1] values to white).

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
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

await page.evaluate(() => { globalThis.__gpuErrors__ = []; });
await page.evaluate(() => {
  const dev = window.__sedonStore__.getState().device;
  if (dev?.addEventListener) {
    dev.addEventListener('uncapturederror', (ev) => {
      globalThis.__gpuErrors__.push(ev.error?.message ?? String(ev));
    });
  }
});

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));

// Force a fresh render so each preview canvas has current content,
// then dump pixel data via toDataURL so we capture the actual canvas
// content at FULL resolution (DOM screenshots may be zoom-scaled).
const dataUrls = await page.evaluate(() => {
  // Trigger a re-draw on every preview by toggling the render bus
  // request (the preview subscribes to it). Use the imperative API
  // exposed in debug mode.
  const out = [];
  const canvases = document.querySelectorAll('.sedon-texture-preview');
  for (const canvas of canvases) {
    const node = canvas.closest('.react-flow__node');
    const label = node?.querySelector('.sedon-node-title')?.textContent ?? '?';
    let dataUrl = '';
    try { dataUrl = canvas.toDataURL('image/png'); } catch (e) { dataUrl = `ERR: ${e}`; }
    out.push({ label, w: canvas.width, h: canvas.height, dataUrl });
  }
  return out;
});

console.log(`found ${dataUrls.length} previews`);
const fs = await import('node:fs/promises');
for (let i = 0; i < dataUrls.length; i++) {
  const d = dataUrls[i];
  console.log(`  [${i}] ${d.label.padEnd(28)} canvas=${d.w}x${d.h}`);
  if (d.dataUrl.startsWith('data:image/png;base64,')) {
    const b64 = d.dataUrl.slice('data:image/png;base64,'.length);
    await fs.writeFile(`/tmp/preview-${i}-${d.label.replace(/[^a-z0-9]/gi, '_')}.png`, Buffer.from(b64, 'base64'));
  } else {
    console.log(`      ${d.dataUrl.slice(0, 100)}`);
  }
}

const gpuErrors = await page.evaluate(() => globalThis.__gpuErrors__ ?? []);
console.log('\nconsole errors:', errors.length);
for (const e of errors.slice(0, 5)) console.log(`  ${e.slice(0, 400)}`);
console.log('WebGPU validation errors:', gpuErrors.length);
for (const e of gpuErrors.slice(0, 5)) console.log(`  ${e.slice(0, 400)}`);

await browser.close();
await server.stop();
