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

// 1. User's hacked camera — verbatim
await page.screenshot({ path: '/tmp/city-asis.png' });
console.log('1. user-hacked: /tmp/city-asis.png');

// 2. Wide top-down — show the whole city
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0, pitch: Math.PI * 0.5, distance: 2000, target: [0, 0, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-wide.png' });
console.log('2. wide top-down: /tmp/city-wide.png');

// 3. Same target as user but zoomed out
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0, pitch: Math.PI * 0.5, distance: 500, target: [-300, 0, -500] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-mid.png' });
console.log('3. user target zoomed out: /tmp/city-mid.png');

// 4. Very close-up at user target — see actual building edge
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0, pitch: Math.PI * 0.5, distance: 100, target: [-300, 0, -500] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-close.png' });
console.log('4. close-up at user target: /tmp/city-close.png');

await browser.close();
await server.stop();
