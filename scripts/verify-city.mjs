import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/city';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

try {
  await page.goto(
    `${server.url}?debug=1&scene=city`,
    { waitUntil: 'networkidle2', timeout: 60000 },
  );
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
  // City demo is big (~700 nodes). Give it more time to settle.
  await new Promise((r) => setTimeout(r, 10000));

  await page.screenshot({ path: `${OUT}/overview.png` });

  // Drive the camera to a low-altitude street-level shot.
  await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    s.saveCameraFor('main', { yaw: 0.3, pitch: 0.15, distance: 80, target: [0, 5, 0] });
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${OUT}/street-level.png` });

  // And a top-down planning view.
  await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    s.saveCameraFor('main', { yaw: 0, pitch: 1.4, distance: 1500, target: [0, 0, 0] });
  });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${OUT}/top-down.png` });

  const state = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      subgraphCount: s.subgraphs.length,
      subgraphIds: s.subgraphs.map((sg) => sg.id),
      mainNodeCount: s.mainGraph.nodes.length,
    };
  });
  console.log('Demo state:', JSON.stringify(state, null, 2));

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
