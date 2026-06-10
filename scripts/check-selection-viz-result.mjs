// Capture only the largest canvas on each docs page (the result
// preview pane, not the per-node thumbnails).
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1800, height: 1400 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const pages = [
  'docs/nodes/geom/select-by-angle/',
  'docs/nodes/geom/select-invert/',
  'docs/nodes/geom/select-combine/',
];

try {
  for (const p of pages) {
    await page.goto(`${server.url}${p}?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 3000));
    // Find ALL canvases and grab the largest by area.
    const target = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      let best = null, bestArea = 0;
      for (const c of canvases) {
        const r = c.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          best = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return best;
    });
    console.log(p, 'biggest canvas:', target);
    if (!target) continue;
    const name = p.replace(/\//g, '_');
    await page.screenshot({
      path: `/tmp/${name}_result.png`,
      clip: { x: target.x, y: target.y, width: target.w, height: target.h },
    });
    console.log('  →', `/tmp/${name}_result.png`);
  }
} finally {
  await browser.close();
  server.stop();
}
