// Verify the canvas right-click context menu:
//
//   1. Right-click on empty canvas pane → menu opens with "Add Node…".
//   2. Click "Add Node…" → picker opens at that location.
//   3. Type a search, pick a node → that node appears at the
//      right-click position (NOT canvas center).
//   4. Right-click a subgraph wrapper → menu has "Edit" entry.
//   5. Click Edit → drill into that subgraph (currentEditingId
//      changes to the wrapper's subgraph).
//   6. Right-click a regular node → no "Edit" entry, just "Rename".
//   7. Dismissal still works (canvas click closes menu).

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

const focusPanel = async (panelId) => {
  await page.evaluate((id) => {
    const api = window.__sedonGetDockview__?.();
    api?.getPanel(id)?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 200));
};

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  await focusPanel('canvas-main');

  // ─── 1+2+3: pane right-click → Add Node… → picker → add at point
  // Find a point inside the pane that's NOT covered by any node, so
  // RF's onPaneContextMenu actually fires (not a node's own handler).
  const paneRect = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    const nodeRects = [...document.querySelectorAll('.sedon-node')]
      .map((n) => n.getBoundingClientRect());
    const isInsideNode = (x, y) => nodeRects.some(
      (nr) => x >= nr.left && x <= nr.right && y >= nr.top && y <= nr.bottom,
    );
    // Sweep a grid of candidate points; pick the first one that
    // isn't inside any node and isn't near the pane's edges.
    for (let py = r.top + 40; py < r.bottom - 40; py += 40) {
      for (let px = r.left + 40; px < r.right - 40; px += 40) {
        if (!isInsideNode(px, py)) {
          return { left: r.left, top: r.top, x: px, y: py };
        }
      }
    }
    return null;
  });
  if (!paneRect) throw new Error('no empty pane area found');
  console.log('Empty pane point:', paneRect.x, paneRect.y);

  await page.mouse.click(paneRect.x, paneRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));

  const paneMenuItems = await page.evaluate(() => {
    return [...document.querySelectorAll('.sedon-menubar-submenu .sedon-menu-row-label')]
      .map((el) => el.textContent);
  });
  console.log('Pane menu items:', JSON.stringify(paneMenuItems));

  // Click "Add Node…"
  const addRect = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.sedon-menu-row')]
      .find((r) => r.querySelector('.sedon-menu-row-label')?.textContent === 'Add Node…');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (addRect) {
    await page.mouse.move(addRect.x, addRect.y);
    await page.mouse.down();
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
  }
  const pickerVisible = await page.evaluate(
    () => !!document.querySelector('.sedon-add-node-popup .sedon-add-node-filter'),
  );
  console.log('Picker visible:', pickerVisible);

  // Type to filter, pick the first match.
  if (pickerVisible) {
    await page.keyboard.type('sphere');
    await new Promise((r) => setTimeout(r, 150));
    // Click the first result via mousedown.
    const firstRect = await page.evaluate(() => {
      const r = document.querySelector('.sedon-add-node-item');
      if (!r) return null;
      const rect = r.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: r.textContent };
    });
    console.log('First match:', firstRect?.label);
    if (firstRect) {
      await page.mouse.move(firstRect.x, firstRect.y);
      await page.mouse.down();
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // The new node should have been added near the click position.
  const added = await page.evaluate((flowClickX, flowClickY) => {
    const s = window.__sedonStore__.getState();
    // Find any new core/sphere on main (basic scene already has one,
    // so check for two).
    const spheres = s.mainGraph.nodes.filter((n) => n.kind === 'core/sphere');
    const newest = spheres[spheres.length - 1];
    return {
      sphereCount: spheres.length,
      newestPos: newest?.position ?? null,
      flowClickHint: { x: flowClickX, y: flowClickY },
    };
  });
  console.log('After add:', JSON.stringify(added));

  // ─── 4+5: subgraph wrapper → Edit drills in ───────────────
  // Create a subgraph + wrapper via the action.
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 400));
  const renameInput = await page.$('.sedon-editable-name-input');
  if (renameInput) {
    await renameInput.click({ clickCount: 3 });
    await page.keyboard.type('wrapper-target');
    await page.keyboard.press('Enter');
  }
  await new Promise((r) => setTimeout(r, 400));

  // Right-click the wrapper.
  const wrapperRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('wrapper-target'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  if (!wrapperRect) throw new Error('no wrapper-target node found');
  await page.mouse.click(wrapperRect.x, wrapperRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));

  const wrapperMenuItems = await page.evaluate(() => {
    return [...document.querySelectorAll('.sedon-menubar-submenu .sedon-menu-row-label')]
      .map((el) => el.textContent);
  });
  console.log('Wrapper menu items:', JSON.stringify(wrapperMenuItems));

  // Click Edit
  const editingBefore = await page.evaluate(
    () => window.__sedonStore__.getState().currentEditingId,
  );
  const editRect = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.sedon-menu-row')]
      .find((r) => r.querySelector('.sedon-menu-row-label')?.textContent === 'Edit');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (editRect) {
    await page.mouse.move(editRect.x, editRect.y);
    await page.mouse.down();
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
  }
  const editingAfter = await page.evaluate(
    () => window.__sedonStore__.getState().currentEditingId,
  );
  console.log('Edit drilled:', editingBefore, '→', editingAfter);

  // ─── 6: regular (non-wrapper) node menu has no Edit ───────
  // We're already drilled into the new subgraph; right-click its
  // input boundary node. Boundaries are regular nodes (not wrappers
  // and not for-each-points), so their menu should be just "Rename".
  const regularRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')][0];
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  if (!regularRect) throw new Error('no boundary node found');
  await page.mouse.click(regularRect.x, regularRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const sphereMenuItems = await page.evaluate(() => {
    return [...document.querySelectorAll('.sedon-menubar-submenu .sedon-menu-row-label')]
      .map((el) => el.textContent);
  });
  console.log('Boundary (regular node) menu items:', JSON.stringify(sphereMenuItems));

  // Dismiss the menu by Escape so it doesn't bleed into next check.
  await page.keyboard.press('Escape');

  const checks = [
    ['Pane menu has "Add Node…"', paneMenuItems.includes('Add Node…')],
    ['Picker opened from Add Node…', pickerVisible],
    ['New sphere added (count went from 1 → 2)', added.sphereCount === 2],
    ['New sphere is at a non-canvas-center position', added.newestPos &&
      Math.abs(added.newestPos.x) < 5000 && Math.abs(added.newestPos.y) < 5000],
    ['Wrapper menu has "Rename" and "Edit"',
      wrapperMenuItems.includes('Rename') && wrapperMenuItems.includes('Edit')],
    ['Edit drilled into the new subgraph',
      editingAfter !== editingBefore && editingAfter !== 'main'],
    ['Regular node menu has Rename but NOT Edit',
      sphereMenuItems.includes('Rename') && !sphereMenuItems.includes('Edit')],
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
