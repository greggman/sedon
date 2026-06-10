// Diagnose: when F is pressed in the canvas with NOTHING selected,
// where is the keydown actually delivered? Hypothesis: focus is on
// document.body (or a non-canvas element), so the wrapper-level
// onKeyDown listener never fires.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();

await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => typeof window.__sedonStore__ !== 'undefined', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// Click empty area of canvas pane to ensure no node is selected.
const pane = await page.$('.react-flow__pane');
const box = await pane.boundingBox();
await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.1);
await new Promise((r) => setTimeout(r, 200));

// Probe selection + focus state.
const probe1 = await page.evaluate(() => {
  const ae = document.activeElement;
  return {
    activeTag: ae?.tagName,
    activeClass: ae?.className?.toString?.().slice?.(0, 120) ?? null,
    activeId: ae?.id,
    selectedNodes: [...document.querySelectorAll('.react-flow__node.selected')].map((n) => n.getAttribute('data-id')),
  };
});
console.log('after click empty pane:', JSON.stringify(probe1, null, 2));

// Now press F and capture the event target.
await page.evaluate(() => {
  window.__lastFTarget__ = null;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      const t = e.target;
      window.__lastFTarget__ = { tag: t?.tagName, cls: t?.className?.toString?.().slice?.(0, 120) ?? null, id: t?.id };
    }
  }, true);
});
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 200));
const ftarget = await page.evaluate(() => window.__lastFTarget__);
console.log('F keydown delivered to:', JSON.stringify(ftarget, null, 2));

await browser.close();
await server.stop();
