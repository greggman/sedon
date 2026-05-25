// "+ Add Node" popup must fit inside the canvas panel — even when the
// panel is shorter than the viewport (as it is by default now that
// Assets sits under Canvas at ~25% of the column).
//
// Before the fix, the popup used `max-height: calc(100vh - 60px)` so
// it could extend past the panel's bottom into the panel's
// `overflow: hidden` clip zone, hiding the bottom items.
//
// Verifies:
//   1. With the forest demo loaded (60+ registered node kinds across
//      many categories — enough to overflow most panel heights), the
//      popup's bottom does NOT extend below the canvas panel's bottom.
//   2. The popup is internally scrollable, so all entries are still
//      reachable: scrolling to the bottom is possible AND brings new
//      content into view.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Forest brings in all the node categories (lots of branch/, leaf/,
// flower/, fern/ kinds plus subgraphs) — pushes the menu past any
// reasonable panel height.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 1000));

// Click the "+ Add Node" button.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.sedon-add-node-menu .sedon-toolbar-button')]
    .find((b) => b.textContent?.includes('Add Node'));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 200));

const m = await page.evaluate(() => {
  const popup = document.querySelector('.sedon-add-node-popup');
  const panel = document.querySelector('.sedon-panel--canvas');
  if (!popup || !panel) return null;
  const pR = popup.getBoundingClientRect();
  const cR = panel.getBoundingClientRect();
  return {
    popup: {
      top: Math.round(pR.top),
      bottom: Math.round(pR.bottom),
      visibleH: Math.round(pR.height),
      contentH: popup.scrollHeight,
      scrollable: popup.scrollHeight > popup.clientHeight + 1,
      maxHeight: getComputedStyle(popup).maxHeight,
    },
    panel: { top: Math.round(cR.top), bottom: Math.round(cR.bottom), h: Math.round(cR.height) },
    viewportH: window.innerHeight,
  };
});
console.log('measurements:', m);

// Resize the canvas panel down by dragging the canvas/assets splitter
// upward, then confirm the popup re-clamps live (no JS measurement
// fires — this is the container-query test). With the JS-measure
// solution this would have stayed at the original max-height.
const resized = await page.evaluate(() => {
  const api = window.__sedonGetDockview__();
  const canvasPanel = api?.panels.find((p) => p.id === 'canvas-main');
  if (!canvasPanel) return null;
  // setSize shrinks the canvas panel; DockView recalculates the
  // adjacent assets panel to fill remaining vertical space.
  canvasPanel.api.setSize({ height: 300 });
  return true;
});
await new Promise((r) => setTimeout(r, 400));
const afterResize = await page.evaluate(() => {
  const popup = document.querySelector('.sedon-add-node-popup');
  const panel = document.querySelector('.sedon-panel--canvas');
  if (!popup || !panel) return null;
  const pR = popup.getBoundingClientRect();
  const cR = panel.getBoundingClientRect();
  return {
    panelH: Math.round(cR.height),
    popupBottom: Math.round(pR.bottom),
    panelBottom: Math.round(cR.bottom),
    popupVisibleH: Math.round(pR.height),
    popupMaxHeight: getComputedStyle(popup).maxHeight,
  };
});
console.log('after panel shrink:', afterResize);

// Scroll the popup to the bottom and confirm the last entry comes
// into view (i.e. we can actually reach the items the user couldn't
// reach before).
const scrollOk = await page.evaluate(() => {
  const popup = document.querySelector('.sedon-add-node-popup');
  if (!popup) return null;
  popup.scrollTop = popup.scrollHeight;
  // The very last item: the last child's last <button>.
  const allButtons = popup.querySelectorAll('button.sedon-add-node-item');
  const last = allButtons[allButtons.length - 1];
  if (!last) return { reachedBottom: false };
  const lr = last.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();
  // Last item's center must lie within the popup's visible scroll
  // area after scrolling to bottom.
  const lastInView = lr.top >= pr.top - 1 && lr.bottom <= pr.bottom + 1;
  return {
    reachedBottom: true,
    lastInView,
    lastLabel: last.textContent?.trim() ?? '',
  };
});
console.log('scroll-to-bottom:', scrollOk);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
if (!m) {
  console.log('FAIL: popup or canvas panel not found');
  process.exit(1);
}
// 2px of slop for sub-pixel rounding.
const popupFits = m.popup.bottom <= m.panel.bottom + 2;
const popupActuallyClamped = m.popup.visibleH < m.popup.contentH;
const lastReachable = scrollOk?.lastInView === true;
// Sanity: the panel is genuinely shorter than the viewport (so the
// test is exercising the real failure mode, not just any popup that
// happens to fit because the viewport is huge).
const panelShorterThanViewport = m.panel.h < m.viewportH - 100;

const popupReclampedOnResize = afterResize
  && afterResize.popupBottom <= afterResize.panelBottom + 2
  && afterResize.popupVisibleH < m.popup.visibleH;

console.log(`canvas panel shorter than viewport:     ${panelShorterThanViewport ? 'PASS ✓' : 'FAIL ✗'} (panel h=${m.panel.h}, viewport h=${m.viewportH})`);
console.log(`popup bottom ≤ panel bottom:            ${popupFits ? 'PASS ✓' : 'FAIL ✗'} (popup bottom=${m.popup.bottom}, panel bottom=${m.panel.bottom})`);
console.log(`popup is internally scrollable:         ${popupActuallyClamped ? 'PASS ✓' : 'FAIL ✗'} (visible=${m.popup.visibleH}px, content=${m.popup.contentH}px)`);
console.log(`popup re-clamps when panel shrinks:     ${popupReclampedOnResize ? 'PASS ✓' : 'FAIL ✗'} (panel ${m.panel.h}→${afterResize?.panelH}px; popup visible ${m.popup.visibleH}→${afterResize?.popupVisibleH}px)`);
console.log(`scroll-to-bottom shows last item:       ${lastReachable ? 'PASS ✓' : 'FAIL ✗'} (last = "${scrollOk?.lastLabel}")`);

const ok = panelShorterThanViewport && popupFits && popupActuallyClamped && popupReclampedOnResize && lastReachable;
process.exit(ok ? 0 : 1);
