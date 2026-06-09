import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('CONSOLE-ERR:', msg.text());
});

await page.goto(`${server.url}?debug=1&scene=city`, { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 20000));

// Look straight down on the intersection of the two N-S/E-W roads
// (at -100, 0, -180 — where road x=-100 crosses z=-180). Lamps should
// NOT be in the asphalt; the four kerb corners should each have a
// lamp nearby.
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0, pitch: Math.PI * 0.5, distance: 60, target: [-100, 0, -180] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-intersection.png' });
console.log('intersection top-down: /tmp/city-intersection.png');

// Block corner — confirm buildings don't overlap each other at the
// polygon vertex. Pick a block-corner near (-100, 0, -180).
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0, pitch: Math.PI * 0.5, distance: 30, target: [-130, 0, -210] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-block-corner.png' });
console.log('block corner: /tmp/city-block-corner.png');

await browser.close();
await server.stop();
