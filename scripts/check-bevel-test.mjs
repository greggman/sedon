// Load the bevel-test demo and capture the shaded 3D preview pane.
// Lets us see whether the blue cube actually has rounded edges (the
// material catches highlights on the bevel) vs. carved grooves.
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
  await new Promise((r) => setTimeout(r, 3500));

  const info = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodes: s.graph.nodes.map((n) => n.kind),
      subgraphs: s.subgraphs.map((sg) => sg.id),
    };
  });
  console.log('graph:', JSON.stringify(info));

  // Capture the LARGEST canvas — that's the main render viewport.
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
  if (!box) { console.log('no canvas'); process.exit(0); }
  console.log('biggest canvas:', box);
  await page.screenshot({
    path: '/tmp/bevel-test.png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h },
  });
  console.log('→ /tmp/bevel-test.png');
} finally {
  await browser.close();
  server.stop();
}
