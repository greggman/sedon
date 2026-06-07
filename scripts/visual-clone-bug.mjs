// Screenshot the showroom BEFORE and AFTER cloning wood-texture and
// changing the clone's color_dark to red. If the showroom changes,
// the original wood-texture is being mutated (or the chair is
// somehow picking up the clone). If it stays the same, the user is
// misobserving.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/clone-bug';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();

try {
  await page.goto(`${server.url}?debug=1&scene=furniture`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 5000));

  await page.screenshot({ path: `${OUT}/01-before.png` });
  console.log('saved before');

  // Clone wood-texture.
  const cloneId = await page.evaluate(() => {
    return window.__sedonStore__.getState()
      .pasteCopyAssets({ subgraphIds: ['wood-texture'], folderIds: [] }, null)
      .subgraphIds[0];
  });
  console.log('clone id:', cloneId);

  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${OUT}/02-after-clone.png` });

  // Modify clone's color_dark to red.
  await page.evaluate((cid) => {
    window.__sedonStore__.getState().setSubgraphInputDefault(cid, 'color_dark', [1, 0, 0, 1]);
  }, cloneId);

  await new Promise((r) => setTimeout(r, 3000));
  await page.screenshot({ path: `${OUT}/03-after-clone-red.png` });
  console.log('saved after');
} finally {
  await browser.close();
  await server.stop();
}
