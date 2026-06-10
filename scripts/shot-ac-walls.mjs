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

// View looking ALONG a side wall — should see AC units in profile
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 1.57, pitch: 0.4, distance: 50, target: [-100, 15, -50] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ timeout: 180000, path: '/tmp/city-ac-side.png' });
console.log('AC side view: /tmp/city-ac-side.png');

// Looking AT a side wall straight-on — see AC units head-on
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 1.57, pitch: 0.0, distance: 30, target: [0, 15, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ timeout: 180000, path: '/tmp/city-ac-front.png' });
console.log('AC front view: /tmp/city-ac-front.png');

await browser.close();
await server.stop();
