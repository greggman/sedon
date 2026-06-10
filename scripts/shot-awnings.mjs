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

// Pedestrian-eye view looking down a street so a row of storefront
// awnings shows. Low pitch, close distance, target is at storefront
// height (~3 m).
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.2, pitch: 0.15, distance: 40, target: [0, 3, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-awnings-street.png' });
console.log('awnings street level: /tmp/city-awnings-street.png');

// Wider shot showing awnings along multiple buildings
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.4, pitch: 0.25, distance: 80, target: [50, 5, 50] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: '/tmp/city-awnings-row.png' });
console.log('awnings row: /tmp/city-awnings-row.png');

await browser.close();
await server.stop();
