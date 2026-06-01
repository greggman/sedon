// Capture a zoomed-in screenshot of the preview pane for each
// selection docs page, so we can actually see whether selected and
// unselected edges render in their respective palettes.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1800, height: 1400 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const pages = [
  'docs/nodes/core/select-by-angle/',
  'docs/nodes/core/select-invert/',
  'docs/nodes/core/select-combine/',
];

try {
  for (const p of pages) {
    await page.goto(`${server.url}${p}?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 3000));
    // Find the preview canvas and screenshot just that element.
    const handle = await page.$('canvas');
    if (!handle) {
      console.log('no canvas found on', p);
      continue;
    }
    const box = await handle.boundingBox();
    console.log(p, 'canvas box:', box);
    const name = p.replace(/\//g, '_');
    await handle.screenshot({ path: `/tmp/${name}_zoom.png` });
    console.log('  →', `/tmp/${name}_zoom.png`);
  }
} finally {
  await browser.close();
  server.stop();
}
