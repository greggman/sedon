// Open the lathe docs page → open curve-2d editor → capture a screenshot
// of the popup. With flipY on, the candlestick silhouette (y=0 at base,
// y=1 at top) should render with the small base radius near the BOTTOM
// of the editor canvas and the wider top near the TOP — i.e. matching
// the 3D preview's orientation, not flipped.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();

try {
  await page.goto(`${server.url}docs/nodes/core/lathe/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Open editor.
  await page.evaluate(() => {
    document.querySelector('.sedon-pointlist-trigger')?.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // Read out the rendered point positions to verify Y-flip.
  const points = await page.evaluate(() => {
    const handles = Array.from(document.querySelectorAll('.sedon-pointlist-handle'));
    return handles.map((h) => {
      const cx = parseFloat(h.getAttribute('cx') ?? '0');
      const cy = parseFloat(h.getAttribute('cy') ?? '0');
      return { cx, cy };
    });
  });
  // The candlestick default: y=0 is base (small radius), y=1 is top
  // (slightly wider). With flipY on, y=0 (the LOW y value) should map
  // to the BOTTOM of the SVG (higher cy in SVG coordinates).
  const first = points[0]; // [0.04, 0, 0.00] — base
  const last = points[points.length - 1]; // [0.10, 0, 1.00] — top
  console.log(`first (base, y=0):  cy=${first?.cy.toFixed(1)}`);
  console.log(`last  (top,  y=1):  cy=${last?.cy.toFixed(1)}`);
  console.log(first && last && first.cy > last.cy
    ? 'PASS: base sits below top in editor (Y-up correctly).'
    : 'FAIL: base is above top — still flipped.');

  await page.screenshot({ path: '/tmp/curve-2d-editor.png' });
  console.log('screenshot: /tmp/curve-2d-editor.png');
} finally {
  await browser.close();
  server.stop();
}
