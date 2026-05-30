// Open tree-bush, switch preview to Branch Canopy, zoom in, capture
// the close-up so we can SEE the bottle-brush effect the user is
// describing.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 4000));

const ids = await page.evaluate(() => {
  const subs = window.__sedonStore__.getState().subgraphs;
  const canopy = subs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
  return { canopyId: canopy.id };
});

// Pin the preview to the canopy subgraph (so we see ONLY the canopy tree).
await page.evaluate((cid) => {
  if (window.__sedonOpenGraphInPreview__) {
    window.__sedonOpenGraphInPreview__(cid, 'preview-main');
  }
}, ids.canopyId);
await new Promise((r) => setTimeout(r, 3000));

// Set a close-up camera on the canopy subgraph: pulled in tight, low pitch.
await page.evaluate((cid) => {
  const layout = window.__sedonLayoutStore__?.getState();
  if (layout?.savePreviewCamera) {
    layout.savePreviewCamera('preview-main', cid, {
      yaw: 0.6,
      pitch: 0.05,
      distance: 4,        // very close-in
      target: [0, 9, 0],  // up in the canopy
    });
  }
}, ids.canopyId);
await new Promise((r) => setTimeout(r, 2000));

async function biggestCanvasShot(path) {
  const handle = await page.evaluateHandle(() => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const area = c.clientWidth * c.clientHeight;
      if (!best || area > best.area) best = { el: c, area };
    }
    return best?.el ?? null;
  });
  await handle.asElement()?.screenshot({ path });
}

await biggestCanvasShot('/tmp/canopy-zoom.png');
console.log('saved /tmp/canopy-zoom.png');

await browser.close();
await server.stop();
