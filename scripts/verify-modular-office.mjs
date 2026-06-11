import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE-ERR:', m.text()); });

await page.goto(`${server.url}?debug=1&scene=single-building`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(
  () => typeof window.__sedonStore__ !== 'undefined' && window.__sedonStore__.getState().graph.nodes.length > 0,
  { timeout: 15000 },
);
await new Promise((r) => setTimeout(r, 5000));

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
await page.screenshot({ path: '/tmp/modular-office.png', clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
console.log('→ /tmp/modular-office.png');

await browser.close();
await server.stop();
console.log('OK');
