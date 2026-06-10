// Reproduce the "View → Frame Selected does nothing in the canvas"
// bug end-to-end. Records the ReactFlow viewport transform before /
// after invoking the action from the menu so we can tell whether a
// fit-view actually happened.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => { errs.push(`[pageerror] ${e.message}`); console.error('PAGEERROR:', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errs.push(`[err] ${msg.text()}`); console.error('CONSOLE-ERR:', msg.text()); }
});

await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// Read the React Flow viewport transform style from the active
// canvas. Format: "translate(<x>px, <y>px) scale(<z>)". We compare
// before/after to detect fit-view.
async function viewportTransform() {
  return page.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport');
    return el ? el.getAttribute('style') : null;
  });
}

async function clickViewMenu(itemLabel) {
  // Open View menu
  const view = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('.sedon-menubar-item')]
      .find((el) => el.textContent?.trim() === 'View');
  });
  await view.asElement().click();
  await new Promise((r) => setTimeout(r, 150));
  // Click the requested item
  const item = await page.evaluateHandle((label) => {
    return [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row')]
      .find((row) => row.querySelector('.sedon-menu-row-label')?.textContent?.trim() === label);
  }, itemLabel);
  if (!item.asElement()) throw new Error(`menu item "${itemLabel}" not found`);
  const box = await item.asElement().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise((r) => setTimeout(r, 600));
}

// First focus the canvas — click somewhere harmless inside the
// canvas panel so it's the active dockview panel.
const canvasArea = await page.$('.react-flow__pane');
if (canvasArea) {
  const box = await canvasArea.boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await new Promise((r) => setTimeout(r, 200));
}

// Pan the canvas to a known offset so the "nothing happens" case
// would leave us at THIS offset (not the default).
await page.evaluate(() => {
  // Find the active canvas's RF instance via the registry hook.
  // The store's syncCounter bump-triggers a refresh of React Flow,
  // but we can also drive RF directly via its API exported on the
  // panel. Simpler: programmatically set the viewport via the
  // public window helper used by other repros — if it's not there,
  // we have to push a scroll. Use page.mouse.wheel to scroll the
  // viewport in CSS terms.
});
// Capture a starting transform — we'll detect fit-view by transform change.
const before = await viewportTransform();
console.log('viewport before:', before);

async function pan() {
  // Drag the pane far so nodes go off-screen; afterwards fitView
  // should snap back. Use middle-mouse on the .react-flow__pane.
  const pane = await page.$('.react-flow__pane');
  const box = await pane.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width / 2 + 2000, box.y + box.height / 2 + 2000, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await new Promise((r) => setTimeout(r, 200));
}

await pan();
const beforeMenu = await viewportTransform();
console.log('viewport before menu :', beforeMenu);
await clickViewMenu('Frame Selected');
const afterMenu = await viewportTransform();
console.log('viewport after menu  :', afterMenu);
const menuChanged = beforeMenu !== afterMenu;
console.log('menu fitView fired   :', menuChanged);

// Now test the in-canvas F-key path. Re-focus the canvas, pan,
// then press F directly.
const pane = await page.$('.react-flow__pane');
if (pane) {
  const box = await pane.boundingBox();
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await new Promise((r) => setTimeout(r, 200));
}
await pan();
const beforeF = await viewportTransform();
console.log('viewport before F    :', beforeF);
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 600));
const afterF = await viewportTransform();
console.log('viewport after F     :', afterF);
const fChanged = beforeF !== afterF;
console.log('F-key fitView fired  :', fChanged);

const transformChanged = menuChanged && fChanged;
console.log('transform changed:', transformChanged);

await browser.close();
await server.stop();

if (errs.length) {
  console.error('errors:', errs);
  process.exit(1);
}
if (!transformChanged) {
  console.error('BUG REPRODUCED: View → Frame Selected did not change canvas viewport');
  process.exit(1);
}
console.log('OK');
