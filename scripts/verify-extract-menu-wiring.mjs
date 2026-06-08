// Verify the three pieces of menu wiring for Extract to Subgraph:
//
//   1. Edit menu has an "Extract to Subgraph" item.
//   2. Pane right-click menu has "Extract to Subgraph".
//   3. Multi-select right-click opens OUR canvas menu (not the
//      browser's default), and that menu has Extract.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});
page.on('dialog', (d) => { void d.accept(); });

async function focusPanel(panelId) {
  await page.evaluate((id) => {
    window.__sedonGetDockview__?.()?.getPanel(id)?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 200));
}

async function readSubmenuLabels() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.sedon-menubar-submenu[style*="z-index: 1000"] .sedon-menu-row-label')]
      .map((el) => el.textContent),
  );
}

async function readMenuBarSubmenuLabels() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row-label')]
      .map((el) => el.textContent),
  );
}

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));
  await focusPanel('canvas-main');

  // ─── 1. Edit menu ───────────────────────────────────────────
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.sedon-menubar-item')];
    const edit = btns.find((b) => b.textContent === 'Edit');
    edit?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  const editItems = await readMenuBarSubmenuLabels();
  console.log('Edit menu items:', JSON.stringify(editItems));
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 150));

  // ─── 2. Pane menu ───────────────────────────────────────────
  const empty = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    const nodeRects = [...document.querySelectorAll('.sedon-node')]
      .map((n) => n.getBoundingClientRect());
    const isInsideNode = (x, y) => nodeRects.some(
      (nr) => x >= nr.left && x <= nr.right && y >= nr.top && y <= nr.bottom,
    );
    for (let py = r.top + 40; py < r.bottom - 40; py += 40) {
      for (let px = r.left + 40; px < r.right - 40; px += 40) {
        if (!isInsideNode(px, py)) return { x: px, y: py };
      }
    }
    return null;
  });
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const paneItems = await readSubmenuLabels();
  console.log('Pane menu items:', JSON.stringify(paneItems));
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 150));

  // ─── 3. Multi-select context menu ──────────────────────────
  // Multi-select two nodes via ctrl-click.
  const ids = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return s.mainGraph.nodes.slice(0, 2).map((n) => n.id);
  });
  for (const id of ids) {
    const rect = await page.evaluate((id) => {
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + 30, y: r.top + 30 };
    }, id);
    await page.keyboard.down('Meta');
    await page.mouse.click(rect.x, rect.y);
    await page.keyboard.up('Meta');
    await new Promise((r) => setTimeout(r, 100));
  }
  const selCount = await page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node.selected')].length,
  );
  console.log('Multi-selection size:', selCount);

  // Right-click on one of the selected nodes — should open our menu,
  // NOT the browser's default. Multi-select wraps the selected
  // nodes in RF's selection box; the contextmenu event lands on
  // onSelectionContextMenu.
  const targetRect = await page.evaluate((id) => {
    const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  }, ids[0]);
  await page.mouse.click(targetRect.x, targetRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 250));
  const multiMenuCount = await page.evaluate(() =>
    document.querySelectorAll('.sedon-menubar-submenu[style*="z-index: 1000"]').length,
  );
  const multiSelectItems = await readSubmenuLabels();
  console.log('Multi-select menus open:', multiMenuCount,
              '; items:', JSON.stringify(multiSelectItems));

  const checks = [
    ['Edit menu has "Extract to Subgraph"', editItems.includes('Extract to Subgraph')],
    ['Pane menu has "Extract to Subgraph"', paneItems.includes('Extract to Subgraph')],
    ['Multi-selection has 2 nodes', selCount === 2],
    ['Multi-select right-click opened our menu (not browser default)',
      multiSelectItems.length > 0],
    ['Multi-select menu has "Extract to Subgraph"',
      multiSelectItems.includes('Extract to Subgraph')],
    ['Multi-select menu has shared items',
      ['Add Node…', 'Add Subgraph', 'Cut', 'Copy', 'Paste']
        .every((l) => multiSelectItems.includes(l))],
    ['Multi-select menu does NOT have Rename (ambiguous on multi-sel)',
      !multiSelectItems.includes('Rename')],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(allPass && errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
