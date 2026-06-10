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
  { name: 'panorama', yaw: 0.5, pitch: 0.35, distance: 400, target: [0, 30, 0] },
  { name: 'cluster',  yaw: 0.6, pitch: 0.45, distance: 90,  target: [-80, 20, -50] },
  { name: 'street-eye', yaw: 0.2, pitch: 0.1, distance: 35, target: [-100, 5, -50] },
];

for (const cam of cameras) {
  await page.evaluate((c) => {
    window.__sedonStore__.getState().saveCameraFor('main', c);
  }, cam);
  await new Promise((r) => setTimeout(r, 5000));
  const path = `/tmp/city-${cam.name}.png`;
  try {
    await page.screenshot({ timeout: 180000, path });
    console.log(`shot ${cam.name}: ${path}`);
  } catch (e) {
    console.error(`screenshot ${cam.name} failed:`, e.message);
  }
}

await browser.close();
await server.stop();
