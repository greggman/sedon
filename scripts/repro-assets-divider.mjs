// Draggable divider between the Assets folder tree and the contents
// list. Verifies:
//   1. A divider element exists between tree and contents.
//   2. Dragging it horizontally changes the tree column's width.
//   3. The new width is persisted in the layout-store
//      (`assetsTreeWidth`) so it survives across re-renders / reloads.
//   4. Width is clamped to the configured min (80px) — dragging way
//      to the left doesn't collapse the column entirely.

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
await page.waitForFunction(() => typeof window.__sedonLayoutStore__ === 'function', { timeout: 10000 });
// Need a project loaded for the Assets panel to show anything useful.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 2500));

// Locate the divider and the body.
const initial = await page.evaluate(() => {
  const divider = document.querySelector('.sedon-assets-divider');
  const tree = document.querySelector('.sedon-assets-tree');
  const body = document.querySelector('.sedon-assets-body');
  if (!divider || !tree || !body) return null;
  const dr = divider.getBoundingClientRect();
  const tr = tree.getBoundingClientRect();
  return {
    storeWidth: window.__sedonLayoutStore__.getState().assetsTreeWidth,
    treeRectWidth: tr.width,
    dividerCenterX: dr.x + dr.width / 2,
    dividerCenterY: dr.y + dr.height / 2,
    bodyLeft: body.getBoundingClientRect().left,
  };
});
if (!initial) { console.log('FAIL: assets panel not mounted'); process.exit(1); }
console.log('initial:', initial);

// Drag the divider 60 px to the right.
const targetX = initial.dividerCenterX + 60;
await page.mouse.move(initial.dividerCenterX, initial.dividerCenterY);
await page.mouse.down();
await page.mouse.move(targetX, initial.dividerCenterY, { steps: 10 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 250));

const afterRight = await page.evaluate(() => {
  const tree = document.querySelector('.sedon-assets-tree');
  return {
    storeWidth: window.__sedonLayoutStore__.getState().assetsTreeWidth,
    treeRectWidth: tree?.getBoundingClientRect().width ?? 0,
  };
});
console.log('after +60px drag:', afterRight);

// Drag way to the LEFT — should clamp at 80 (the store's min).
const dividerNowX = await page.evaluate(() => {
  const d = document.querySelector('.sedon-assets-divider');
  return d ? d.getBoundingClientRect().x + d.getBoundingClientRect().width / 2 : null;
});
await page.mouse.move(dividerNowX, initial.dividerCenterY);
await page.mouse.down();
await page.mouse.move(initial.bodyLeft - 500, initial.dividerCenterY, { steps: 10 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 250));

const afterFarLeft = await page.evaluate(() => ({
  storeWidth: window.__sedonLayoutStore__.getState().assetsTreeWidth,
  treeRectWidth: document.querySelector('.sedon-assets-tree')?.getBoundingClientRect().width ?? 0,
}));
console.log('after far-left drag (should clamp):', afterFarLeft);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const dividerExists = initial.dividerCenterX > initial.bodyLeft;
const dragGrew = afterRight.storeWidth > initial.storeWidth + 40 // ~60 px expected; allow slack
  && afterRight.treeRectWidth > initial.treeRectWidth + 40;
const clampedToMin = afterFarLeft.storeWidth === 80
  && Math.abs(afterFarLeft.treeRectWidth - 80) < 2;
console.log(`divider element exists between tree+contents: ${dividerExists ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`drag right → both store + DOM width grew:     ${dragGrew ? 'PASS ✓' : 'FAIL ✗'} (${initial.storeWidth}→${afterRight.storeWidth})`);
console.log(`drag far-left → width clamped to 80 px:       ${clampedToMin ? 'PASS ✓' : 'FAIL ✗'} (got ${afterFarLeft.storeWidth})`);
process.exit(dividerExists && dragGrew && clampedToMin ? 0 : 1);
