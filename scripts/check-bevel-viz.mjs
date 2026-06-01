// Render the core/bevel docs preview to verify the chamfered cube
// looks reasonable end-to-end (node registered, GPU mesh round-trips
// through the preview, geometry matches the unit-test counts).
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1800, height: 1400 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console error]', msg.text()); });

try {
  await page.goto(`${server.url}docs/nodes/core/bevel/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3000));

  const info = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    return { kinds: state.graph.nodes.map((n) => n.kind) };
  });
  console.log('graph:', JSON.stringify(info));

  // Capture the biggest canvas (the result preview pane).
  const target = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    let best = null, bestArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = { x: r.x, y: r.y, w: r.width, h: r.height }; }
    }
    return best;
  });
  if (!target) { console.log('no canvas'); process.exit(0); }
  console.log('result canvas:', target);
  await page.screenshot({
    path: '/tmp/bevel.png',
    clip: { x: target.x, y: target.y, width: target.w, height: target.h },
  });
  console.log('→ /tmp/bevel.png');
} finally {
  await browser.close();
  server.stop();
}
