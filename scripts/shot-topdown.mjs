import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('CONSOLE-ERR:', msg.text());
});

await page.goto(`${server.url}?debug=1&scene=city`, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 45000));

const cameras = [
  // Top-down on a block, showing building footprints + outward
  // projections (fire escapes should stick out from sides).
  { name: 'topdown-block', yaw: 0, pitch: 1.55, distance: 80, target: [50, 0, 50] },
  // Slightly angled top-down so we see both rooftops AND wall projections.
  { name: 'birds-eye', yaw: 0.5, pitch: 1.2, distance: 120, target: [0, 15, 0] },
  // Looking straight at a building from very close — should see
  // fire escape if it's there.
  { name: 'wall-zoom', yaw: 1.57, pitch: 0.3, distance: 25, target: [50, 12, 200] },
];

for (const cam of cameras) {
  await page.evaluate((c) => {
    window.__sedonStore__.getState().saveCameraFor('main', c);
  }, cam);
  await new Promise((r) => setTimeout(r, 4000));
  try {
    await page.screenshot({ timeout: 180000, path: `/tmp/city-${cam.name}.png` });
    console.log(`shot ${cam.name}`);
  } catch (e) {
    console.error(`screenshot ${cam.name} failed:`, e.message);
  }
}

await browser.close();
await server.stop();
