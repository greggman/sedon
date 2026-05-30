// Capture the rendered terrain scene (not the in-node texture preview)
// from the multi-layer-terrain demo so we can see whether the few
// outlier pixels in the eroded heightfield show up as spikes in the
// actual mesh.

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
await new Promise((r) => setTimeout(r, 5000));

// The Preview panel's WebGPU canvas — that's the actual rendered terrain.
const sceneCanvas = await page.$('.sedon-preview-canvas canvas, canvas.sedon-preview-canvas');
if (!sceneCanvas) {
  console.log('no scene canvas found');
} else {
  await sceneCanvas.screenshot({ path: '/tmp/erosion-rendered-scene.png' });
  console.log('saved /tmp/erosion-rendered-scene.png');
}

await browser.close();
await server.stop();
