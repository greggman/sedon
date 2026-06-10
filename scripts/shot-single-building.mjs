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

await page.goto(`${server.url}?debug=1&scene=single-building`, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 20000));

const cameras = [
  // Default — full building from +Z side (fire-escape side).
  { name: 'sb-default', yaw: 0.4, pitch: 0.25, distance: 50, target: [0, 14, 0] },
  // Side-on view of the +Z wall — fire escape should be visible
  // running the full body height (ground floor top = Y=5 to roof top
  // = Y=30). Camera positioned past the +Z wall looking back at it.
  { name: 'sb-fire-side', yaw: 1.57, pitch: 0.05, distance: 25, target: [0, 14, 20] },
  // Looking at the -X (storefront) wall.
  { name: 'sb-frontwall', yaw: 0, pitch: 0.05, distance: 25, target: [-15, 14, 0] },
  // Top-down to see roof.
  { name: 'sb-top', yaw: 0, pitch: 1.5, distance: 60, target: [0, 0, 0] },
];

for (const cam of cameras) {
  await page.evaluate((c) => {
    window.__sedonStore__.getState().saveCameraFor('main', c);
  }, cam);
  await new Promise((r) => setTimeout(r, 3000));
  try {
    await page.screenshot({ timeout: 180000, path: `/tmp/${cam.name}.png` });
    console.log(`shot ${cam.name}`);
  } catch (e) {
    console.error(`screenshot ${cam.name} failed:`, e.message);
  }
}

await browser.close();
await server.stop();
