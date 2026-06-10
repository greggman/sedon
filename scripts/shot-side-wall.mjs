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

// Side wall viewpoints. Different angles and positions to find a
// building whose +Z face faces the camera (where fire escapes live).
const cameras = [
  { name: 'side-A', yaw: 0,    pitch: 0.3,  distance: 70, target: [50, 15, 50] },
  { name: 'side-B', yaw: 1.57, pitch: 0.3,  distance: 70, target: [-50, 15, -100] },
  { name: 'side-C', yaw: 0.78, pitch: 0.25, distance: 90, target: [0, 18, 0] },
  { name: 'side-D', yaw: 2.0,  pitch: 0.2,  distance: 60, target: [200, 12, 200] },
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
