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

// Helicopter view — looking down on a block at ~45° from above. Roof
// fittings should be visible as silhouettes on building tops.
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.3, pitch: 0.9, distance: 180, target: [-100, 30, -100] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ timeout: 180000, path: '/tmp/city-rooftops.png' });
console.log('rooftops helicopter: /tmp/city-rooftops.png');

// Single-building close-up — pitch 0.6 ≈ looking slightly down,
// target up near roof height.
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.6, pitch: 0.55, distance: 50, target: [-100, 30, -180] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ timeout: 180000, path: '/tmp/city-roof-close.png' });
console.log('roof close-up: /tmp/city-roof-close.png');

// Spider-Man swing-by perspective — low pitch, close, looking along a
// row of buildings so several roofs line up.
await page.evaluate(() => {
  window.__sedonStore__.getState().saveCameraFor('main',
    { yaw: 0.0, pitch: 0.3, distance: 110, target: [120, 40, 0] });
});
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ timeout: 180000, path: '/tmp/city-spiderman.png' });
console.log('spiderman view: /tmp/city-spiderman.png');

await browser.close();
await server.stop();
