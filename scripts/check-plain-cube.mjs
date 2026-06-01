// Render a PLAIN cube with the same blue material as the bevel-test, to
// isolate whether the black-silhouette issue is in the bevel algorithm
// or in the material/lighting setup.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console]', msg.text()); });

try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

  // Replace the project with a hand-built minimal cube+material+output.
  await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const { createGraph, addNode, addEdge } = window.__sedonCore__ ?? {};
    if (!createGraph) throw new Error('no __sedonCore__');
    const g = createGraph();
    const cube = addNode(g, 'core/cube', { id: 'cube', position: { x: 0, y: 0 }, inputValues: { size: 1 } });
    const mat = addNode(g, 'core/material', { id: 'mat', position: { x: 240, y: 240 }, inputValues: { basecolor: [0.20, 0.45, 0.85, 1], roughness: 0.4, metallic: 0 } });
    const ent = addNode(g, 'core/scene-entity', { id: 'ent', position: { x: 480, y: 120 } });
    const out = addNode(g, 'core/output', { id: 'out', position: { x: 720, y: 120 } });
    addEdge(g, { node: cube.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    addEdge(g, { node: ent.id, socket: 'scene' }, { node: out.id, socket: 'scene' });
    s.loadProject({ graph: g, rootNodeId: out.id, subgraphs: [], cameras: { main: { yaw: 0.7, pitch: 0.4, distance: 3.5, target: [0, 0, 0] } } });
  });
  await new Promise((r) => setTimeout(r, 2000));

  const box = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('canvas'));
    let best = null, bestA = 0;
    for (const c of all) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestA) { bestA = area; best = { x: r.x, y: r.y, w: r.width, h: r.height }; }
    }
    return best;
  });
  await page.screenshot({ path: '/tmp/plain-cube.png', clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  console.log('→ /tmp/plain-cube.png');
} finally {
  await browser.close();
  server.stop();
}
