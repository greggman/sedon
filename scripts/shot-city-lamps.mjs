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

// Street-level view from above, low angle — lamp posts should be visible.
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.3, pitch: 0.2, distance: 80, target: [0, 3, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-lamps.png' });
console.log('lamp-level: /tmp/city-lamps.png');

// Closer street-level with the camera near a road
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.7, pitch: 0.3, distance: 40, target: [-100, 2, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-lamps-close.png' });
console.log('lamp-close: /tmp/city-lamps-close.png');

await browser.close();
await server.stop();
