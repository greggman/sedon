// User's scenario: heightRange [-20, 50], close camera low, looking at horizon.
// Verifies whether water FAR PAST the heightfield shows clear sky reflection
// (correct) or terrain reflection (the bug).
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function');
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
await new Promise((r) => setTimeout(r, 4000));
await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const hf = st.graph.nodes.find((n) => n.kind === 'core/heightfield');
  if (hf) st.setInputValue(hf.id, 'heightRange', [-20, 50]);
  // Distinguishable colors.
  const solids = st.graph.nodes.filter((n) => n.kind === 'core/solid-color').slice(0, 4);
  st.setInputValue(solids[0].id, 'color', [1.0, 0.2, 0.2, 1]);
  st.setInputValue(solids[1].id, 'color', [0.2, 0.8, 0.2, 1]);
  st.setInputValue(solids[2].id, 'color', [0.2, 0.4, 1.0, 1]);
  st.setInputValue(solids[3].id, 'color', [1.0, 1.0, 0.8, 1]);
  // Disable waves so geometry is predictable.
  const water = st.graph.nodes.find((n) => n.kind === 'water/plane');
  if (water) st.setInputValue(water.id, 'wave_strength', 0);
});
await page.evaluate(() => window.__sedonSetAnimating__(true));
await new Promise((r) => setTimeout(r, 2000));

const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-panel--preview canvas');
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
});

// Low camera position, looking horizontally.
await page.evaluate(() => {
  window.__sedonLayoutStore__.getState().savePreviewCamera(
    'preview-main', 'main',
    { yaw: 0, pitch: 0.02, distance: 30, target: [0, 14, 0] },
  );
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  path: `/tmp/far-reflection.png`,
});
console.log('/tmp/far-reflection.png');

await browser.close();
await server.stop();
