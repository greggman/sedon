// Verify the unified pane / node context menu:
//
//   Pane right-click → menu has: Add Node…, Add Subgraph, Cut, Copy,
//     Paste. No Rename / Edit.
//
//   Node right-click (regular node) → menu has all of the above PLUS
//     Rename. No Edit (it's not a wrapper).
//
//   Node right-click (subgraph wrapper) → menu has all of the above
//     PLUS Rename AND Edit.
//
//   "Add Node…" from the node menu still opens the picker.
//
//   "Add Subgraph" from either menu creates a new subgraph wrapper at
//     the click flow position.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? '(no stack)'}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});
page.on('dialog', (d) => { void d.accept(); });

const focusPanel = async (panelId) => {
  await page.evaluate((id) => {
    const api = window.__sedonGetDockview__?.();
    api?.getPanel(id)?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 200));
};

async function readMenuLabels() {
  return page.evaluate(() => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return [];
    return [...menu.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent);
  });
}

async function dismissMenu() {
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 150));
}

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  await focusPanel('canvas-main');

  // ─── 1. Pane menu items ─────────────────────────────────────
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
  if (!empty) throw new Error('no empty area');
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const paneItems = await readMenuLabels();
  console.log('Pane menu items:', JSON.stringify(paneItems));
  await dismissMenu();

  // ─── 2. Regular node menu (sphere) ──────────────────────────
  const sphereRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('sphere'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  if (!sphereRect) throw new Error('no sphere');
  await page.mouse.click(sphereRect.x, sphereRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const sphereItems = await readMenuLabels();
  console.log('Sphere menu items:', JSON.stringify(sphereItems));
  await dismissMenu();

  // ─── 3. Wrapper menu (create one via Add Subgraph from pane) ─
  // We'll exercise the pane menu's Add Subgraph here too.
  const subgraphsBefore = await page.evaluate(
    () => window.__sedonStore__.getState().subgraphs.length,
  );
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const addSgRect = await page.evaluate(() => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return null;
    const row = [...menu.querySelectorAll('.sedon-menu-row')]
      .find((r) => r.querySelector('.sedon-menu-row-label')?.textContent === 'Add Subgraph');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (addSgRect) {
    await page.mouse.move(addSgRect.x, addSgRect.y);
    await page.mouse.down();
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 500));
  }
  const subgraphsAfter = await page.evaluate(
    () => window.__sedonStore__.getState().subgraphs.length,
  );
  const wrapperKind = await page.evaluate(() =>
    window.__sedonStore__.getState().mainGraph.nodes
      .filter((n) => n.kind.startsWith('subgraph/'))
      .map((n) => n.kind)
      .pop(),
  );
  console.log('After Add Subgraph: count', subgraphsBefore, '→', subgraphsAfter, '; wrapper kind:', wrapperKind);

  // Commit the auto-rename so we have a stable wrapper to right-click.
  const input = await page.$('.sedon-editable-name-input');
  if (input) {
    await input.click({ clickCount: 3 });
    await page.keyboard.type('wrapper-test');
    await page.keyboard.press('Enter');
  }
  await new Promise((r) => setTimeout(r, 300));

  // Now right-click the wrapper.
  const wrapperRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('wrapper-test'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  if (!wrapperRect) throw new Error('no wrapper-test');
  await page.mouse.click(wrapperRect.x, wrapperRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const wrapperItems = await readMenuLabels();
  console.log('Wrapper menu items:', JSON.stringify(wrapperItems));
  await dismissMenu();

  // ─── 4. Add Node… from a NODE menu opens picker ─────────────
  await page.mouse.click(sphereRect.x, sphereRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const addNodeRect = await page.evaluate(() => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return null;
    const row = [...menu.querySelectorAll('.sedon-menu-row')]
      .find((r) => r.querySelector('.sedon-menu-row-label')?.textContent === 'Add Node…');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (addNodeRect) {
    await page.mouse.move(addNodeRect.x, addNodeRect.y);
    await page.mouse.down();
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 300));
  }
  const pickerOpen = await page.evaluate(
    () => !!document.querySelector('.sedon-add-node-popup .sedon-add-node-filter'),
  );
  await dismissMenu();

  // ─── Checks ─────────────────────────────────────────────────
  const checks = [
    ['Pane menu has Add Node…', paneItems.includes('Add Node…')],
    ['Pane menu has Add Subgraph', paneItems.includes('Add Subgraph')],
    ['Pane menu has Cut/Copy/Paste',
      paneItems.includes('Cut') && paneItems.includes('Copy') && paneItems.includes('Paste')],
    ['Pane menu does NOT have Rename', !paneItems.includes('Rename')],
    ['Pane menu does NOT have Edit', !paneItems.includes('Edit')],
    ['Regular node menu has all the shared items',
      ['Add Node…', 'Add Subgraph', 'Cut', 'Copy', 'Paste'].every((l) => sphereItems.includes(l))],
    ['Regular node menu has Rename', sphereItems.includes('Rename')],
    ['Regular node menu does NOT have Edit', !sphereItems.includes('Edit')],
    ['Wrapper menu has all the shared items',
      ['Add Node…', 'Add Subgraph', 'Cut', 'Copy', 'Paste'].every((l) => wrapperItems.includes(l))],
    ['Wrapper menu has Rename', wrapperItems.includes('Rename')],
    ['Wrapper menu has Edit', wrapperItems.includes('Edit')],
    ['Add Subgraph created a new subgraph', subgraphsAfter === subgraphsBefore + 1],
    ['Add Subgraph dropped a wrapper in main',
      wrapperKind != null && wrapperKind.startsWith('subgraph/')],
    ['Add Node… from node menu opened the picker', pickerOpen],
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
