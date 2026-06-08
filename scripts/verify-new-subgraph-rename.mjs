// Verify the Finder-style "create + rename now" flow for New Subgraph:
//
//   Case A (asset focused) → subgraph created with default label
//     "untitled subgraph", asset panel navigates to its folder,
//     renames the tile inline (RenameInput visible), scrolled into
//     view. No wrapper in main graph.
//
//   Case B (canvas focused) → subgraph created, wrapper placed in
//     the parent canvas, canvas framed on it, EditableNodeName-input
//     visible on the wrapper. Edit context stayed on the parent.
//
//   Case C (node context menu) → right-click on a node, click
//     "Rename" → that node's name input becomes visible.
//
// Also exercises the bus path with no prompt dialog at all.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/new-subgraph-rename';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});
// If a window.prompt fires, that's a regression — we removed prompts.
page.on('dialog', (d) => {
  errors.push(`[unexpected dialog] type=${d.type()} message=${d.message()}`);
  void d.dismiss();
});

const focusPanel = async (panelId) => {
  const result = await page.evaluate((id) => {
    const api = window.__sedonGetDockview__?.();
    const panel = api?.getPanel(id);
    if (!panel) return { error: `no panel ${id}` };
    panel.api.setActive();
    return { ok: true };
  }, panelId);
  if (!result.ok) throw new Error(`focusPanel(${panelId}) failed: ${JSON.stringify(result)}`);
  await new Promise((r) => setTimeout(r, 200));
};

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  // ─── Case A: asset focused ─────────────────────────────────
  await focusPanel('assets-main');
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/A-asset-after-create.png` });

  const caseA = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const sg = s.subgraphs.find((x) => x.label === 'untitled subgraph');
    const renameInput = document.querySelector('.sedon-assets-rename');
    return {
      subgraphCount: s.subgraphs.length,
      hasUntitledSubgraph: !!sg,
      sgId: sg?.id ?? null,
      sgLabel: sg?.label ?? null,
      mainNodeCount: s.mainGraph.nodes.length,
      renameInputVisible: !!renameInput,
      renameInputValue: renameInput?.value ?? null,
    };
  });
  console.log('Case A:', JSON.stringify(caseA));

  // ─── Reset, then Case B: canvas focused ─────────────────────
  // We can't fire file.new (it would pop a confirm dialog; that's
  // intentionally caught above as an "unexpected dialog"). Reset the
  // store directly via the debug store handle.
  await page.evaluate(() => {
    window.__sedonStore__.getState().markClean();
  });
  await page.evaluate(async () => {
    // Manually accept any window.confirm before file.new fires.
    window.confirm = () => true;
    await window.sedonMcp.call('runAction', { id: 'file.new' });
  });
  await new Promise((r) => setTimeout(r, 600));

  await focusPanel('canvas-main');
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${OUT}/B-canvas-after-create.png` });

  const caseB = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const sg = s.subgraphs.find((x) => x.label === 'untitled subgraph');
    const wrapper = s.mainGraph.nodes.find((n) => sg && n.kind === `subgraph/${sg.id}`);
    const headerInput = document.querySelector('.sedon-editable-name-input');
    return {
      subgraphCount: s.subgraphs.length,
      sgId: sg?.id ?? null,
      mainNodeCount: s.mainGraph.nodes.length,
      hasWrapper: !!wrapper,
      wrapperKind: wrapper?.kind ?? null,
      currentEditing: s.currentEditingId,
      headerInputVisible: !!headerInput,
      headerInputValue: headerInput?.value ?? null,
    };
  });
  console.log('Case B:', JSON.stringify(caseB));

  // ─── Case C: node context menu → Rename ─────────────────────
  // Commit Case B's rename to a known, distinguishable name so we
  // can be sure the input we observe in Case C is freshly opened by
  // the context menu, not a leftover from Case B. Click the input
  // first so keyboard focus is guaranteed (autoFocus may have been
  // bumped by the focusPanel calls earlier in the test).
  const caseBInput = await page.$('.sedon-editable-name-input');
  if (caseBInput) {
    await caseBInput.click({ clickCount: 3 });
    await page.keyboard.type('renamed-for-caseC');
    await page.keyboard.press('Enter');
  }
  await new Promise((r) => setTimeout(r, 300));
  const noInputBetween = await page.evaluate(
    () => !document.querySelector('.sedon-editable-name-input'),
  );
  console.log('  (between B and C: no input present?', noInputBetween, ')');

  // Right-click on the wrapper node we just renamed.
  const targetRect = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.sedon-node')];
    const target = nodes.find((n) =>
      n.textContent?.includes('renamed-for-caseC'),
    );
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 16 };
  });
  if (targetRect) {
    console.log('  (right-clicking at', targetRect, ')');
    await page.mouse.click(targetRect.x, targetRect.y, { button: 'right' });
    await new Promise((r) => setTimeout(r, 300));
    const menuOpen = await page.evaluate(() => {
      const menu = document.querySelector('.sedon-menubar-submenu');
      return menu ? menu.outerHTML.slice(0, 300) : null;
    });
    console.log('  (menu open?', menuOpen ?? 'NO', ')');
    await page.screenshot({ path: `${OUT}/C-node-context-menu.png` });

    // Click "Rename" in the popup.
    const renameRect = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.sedon-menu-row')];
      const target = rows.find((r) =>
        r.querySelector('.sedon-menu-row-label')?.textContent === 'Rename',
      );
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (renameRect) {
      console.log('  (clicking Rename at', renameRect, ')');
      // Use mouseup since the menu uses onMouseUp to dismiss + run.
      await page.mouse.move(renameRect.x, renameRect.y);
      await page.mouse.down();
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 100));
      const postClick = await page.evaluate(() => {
        // Probe the bus & menu state. (Bus isn't exposed on window,
        // so reach in through a known import via the store-aware
        // dynamic import path.)
        const menu = document.querySelector('.sedon-menubar-submenu');
        const inputs = document.querySelectorAll('.sedon-editable-name-input');
        return {
          menuStillOpen: !!menu,
          inputCount: inputs.length,
        };
      });
      console.log('  (post-click:', JSON.stringify(postClick), ')');
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: `${OUT}/D-after-rename-context.png` });
    } else {
      console.log('  (no Rename row found)');
    }
  } else {
    console.log('  (no target rect found)');
  }

  const caseC = await page.evaluate(() => {
    const headerInput = document.querySelector('.sedon-editable-name-input');
    return {
      headerInputVisible: !!headerInput,
      headerInputValue: headerInput?.value ?? null,
      noInputBetween: !document.querySelector('.sedon-editable-name-input--phantom'),
    };
  });
  console.log('Case C:', JSON.stringify(caseC));

  const checks = [
    ['Case A: subgraph created with default label', caseA.hasUntitledSubgraph],
    ['Case A: no wrapper added to main', caseA.mainNodeCount === 5],
    ['Case A: inline rename input visible', caseA.renameInputVisible],
    ['Case A: rename input pre-filled with label', caseA.renameInputValue === 'untitled subgraph'],
    ['Case B: wrapper placed in main', caseB.hasWrapper],
    ['Case B: still editing main', caseB.currentEditing === 'main'],
    ['Case B: header input visible for rename', caseB.headerInputVisible],
    ['Case C: right-click → Rename opens the header input', caseC.headerInputVisible],
    ['Case C: input is fresh (the rename committed before reopened)',
      caseC.headerInputValue !== null && /renamed-for-caseC/.test(caseC.headerInputValue)],
    ['No window.prompt fired', !errors.some((e) => e.startsWith('[unexpected dialog]'))],
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
  console.log(allPass && !errors.some((e) => e.startsWith('[unexpected dialog]')) ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
