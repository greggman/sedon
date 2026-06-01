import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
try {
  await page.goto(`${server.url}?scene=for-each-point&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));
  const box = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('canvas'));
    let best = null, bestA = 0;
    for (const c of all) {
      const r = c.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestA) { bestA = a; best = { x: r.x, y: r.y, w: r.width, h: r.height }; }
    }
    return best;
  });
  await page.screenshot({ path: '/tmp/for-each-point.png', clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
  console.log('→ /tmp/for-each-point.png');
} finally {
  await browser.close();
  server.stop();
}
