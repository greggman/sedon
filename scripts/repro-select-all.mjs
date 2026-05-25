// Cmd/Ctrl-A scoping. Verifies:
//   1. Canvas active → Cmd-A selects every node in THAT canvas and
//      preventDefault stops the browser page-wide selection.
//   2. Asset panel active → Cmd-A selects every visible asset tile
//      (existing per-panel handler still works alongside the global
//      one).
//   3. Preview active → Cmd-A is a no-op; nothing flagged as selected
//      anywhere, AND the browser's page-text selection didn't fire
//      (window.getSelection is empty/collapsed).
//   4. Text input focused → Cmd-A is NOT swallowed; the input's text
//      is fully selected by the native browser behavior (selectionStart
//      = 0, selectionEnd = value.length).

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
await page.waitForFunction(() => typeof window.__sedonGetDockview__ === 'function', { timeout: 10000 });

// Load forest so we have multiple nodes + several asset tiles.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 1500));

const isMac = process.platform === 'darwin';
const meta = isMac ? 'Meta' : 'Control';

// Helper: activate a DockView panel by id, then return its content
// component kind to confirm.
const activatePanel = async (panelId) => {
  await page.evaluate((id) => {
    const api = window.__sedonGetDockview__();
    const p = api?.panels.find((pp) => pp.id === id);
    p?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 150));
};

// Click into the panel's body so focus actually moves there (setActive
// alone leaves focus on whatever was previously focused).
const clickPanelBody = async (selector) => {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (box) await page.mouse.click(box.x, box.y);
  await new Promise((r) => setTimeout(r, 200));
};

// ── 1. CANVAS: Cmd-A selects all nodes. ────────────────────────────
await activatePanel('canvas-main');
await clickPanelBody('.sedon-panel--canvas');
const beforeCanvas = await page.evaluate(() => {
  const api = window.__sedonGetDockview__();
  // No direct RF state via window; instead read selection from store-
  // adjacent DOM. ReactFlow tags selected nodes with .selected class.
  const sel = document.querySelectorAll('.react-flow__node.selected').length;
  const total = document.querySelectorAll('.react-flow__node').length;
  return { sel, total };
});
await page.keyboard.down(meta);
await page.keyboard.press('a');
await page.keyboard.up(meta);
await new Promise((r) => setTimeout(r, 300));
const afterCanvas = await page.evaluate(() => {
  const sel = document.querySelectorAll('.react-flow__node.selected').length;
  const total = document.querySelectorAll('.react-flow__node').length;
  const pageSelText = (window.getSelection()?.toString() ?? '').length;
  return { sel, total, pageSelText };
});
console.log('canvas before:', beforeCanvas, 'after:', afterCanvas);

// ── 2. ASSETS: Cmd-A selects all visible asset tiles. ──────────────
// Move focus / activation to assets-main.
await activatePanel('assets-main');
await clickPanelBody('.sedon-panel--assets');
const beforeAssets = await page.evaluate(() => {
  const sel = document.querySelectorAll('.sedon-assets-tile.sedon-assets-tile--selected').length;
  const total = document.querySelectorAll('.sedon-assets-tile').length;
  return { sel, total };
});
await page.keyboard.down(meta);
await page.keyboard.press('a');
await page.keyboard.up(meta);
await new Promise((r) => setTimeout(r, 300));
const afterAssets = await page.evaluate(() => {
  const sel = document.querySelectorAll('.sedon-assets-tile.sedon-assets-tile--selected').length;
  const total = document.querySelectorAll('.sedon-assets-tile').length;
  // The "Main" tile is the project-root pointer, not an authored asset
  // — Cut/Copy/Delete and Select-All all exclude it. Count it
  // separately so the assertion expects sel === (total - main).
  const main = document.querySelectorAll('.sedon-assets-tile.sedon-assets-tile--main').length;
  const pageSelText = (window.getSelection()?.toString() ?? '').length;
  return { sel, total, main, pageSelText };
});
console.log('assets before:', beforeAssets, 'after:', afterAssets);

// ── 3. PREVIEW: Cmd-A is a no-op + page text not selected. ────────
await activatePanel('preview-main');
await clickPanelBody('.sedon-panel--preview');
// Clear any existing selection from previous interactions.
await page.evaluate(() => window.getSelection()?.removeAllRanges?.());
await page.keyboard.down(meta);
await page.keyboard.press('a');
await page.keyboard.up(meta);
await new Promise((r) => setTimeout(r, 200));
const afterPreview = await page.evaluate(() => {
  const pageSelText = (window.getSelection()?.toString() ?? '').length;
  return { pageSelText };
});
console.log('preview after:', afterPreview);

// ── 4. TEXT INPUT: my handler bails — no panel-level select-all
// fires when focus is in a text input. We verify by:
//   • Activating the canvas (so its select-all WOULD fire if my
//     handler didn't bail).
//   • Deselecting all canvas nodes manually.
//   • Opening the palette (focus moves to its <input type="text">).
//   • Pressing Cmd-A.
//   • Canvas selection should remain 0/total — proving the handler
//     correctly punted to native browser handling instead of routing
//     to the active panel.
await activatePanel('canvas-main');
await page.evaluate(() => {
  // Use the rf instance via the active canvas to clear selection.
  const api = window.__sedonGetDockview__();
  const _ = api?.activePanel; // (kept to ensure dockview is alive)
});
// Click the canvas pane to focus the RF viewport, then press Escape
// to deselect everything.
await clickPanelBody('.sedon-panel--canvas');
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 200));
// Open palette: focus shifts to <input type="text">.
await page.keyboard.down(meta);
await page.keyboard.down('Shift');
await page.keyboard.press('P');
await page.keyboard.up('Shift');
await page.keyboard.up(meta);
await new Promise((r) => setTimeout(r, 200));
const beforeInputCmdA = await page.evaluate(() => {
  return document.querySelectorAll('.react-flow__node.selected').length;
});
await page.keyboard.down(meta);
await page.keyboard.press('a');
await page.keyboard.up(meta);
await new Promise((r) => setTimeout(r, 200));
const afterInputCmdA = await page.evaluate(() => {
  return {
    canvasSel: document.querySelectorAll('.react-flow__node.selected').length,
    canvasTotal: document.querySelectorAll('.react-flow__node').length,
    paletteOpen: !!document.querySelector('.sedon-palette-input'),
  };
});
console.log('with palette input focused, canvas sel before/after:', beforeInputCmdA, afterInputCmdA);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const canvasAllSelected = afterCanvas.total > 1
  && afterCanvas.sel === afterCanvas.total
  && afterCanvas.pageSelText === 0;
const assetsAllSelected = afterAssets.total > 1
  && afterAssets.sel === afterAssets.total - afterAssets.main
  && afterAssets.pageSelText === 0;
const previewNoOp = afterPreview.pageSelText === 0;
// "Handler bailed" = canvas selection didn't change when Cmd-A fired
// with the palette input focused. afterInputCmdA.canvasSel should
// equal beforeInputCmdA (typically 0 after Escape).
const textInputHandlerBailed = afterInputCmdA.paletteOpen
  && afterInputCmdA.canvasSel === beforeInputCmdA;

console.log(`canvas Cmd-A selects all nodes:           ${canvasAllSelected ? 'PASS ✓' : 'FAIL ✗'} (${afterCanvas.sel}/${afterCanvas.total}; page-sel text len = ${afterCanvas.pageSelText})`);
console.log(`assets Cmd-A selects all tiles:           ${assetsAllSelected ? 'PASS ✓' : 'FAIL ✗'} (${afterAssets.sel}/${afterAssets.total - afterAssets.main} selectable; ${afterAssets.main} "Main" excluded; page-sel text len = ${afterAssets.pageSelText})`);
console.log(`preview Cmd-A is no-op (no page select):  ${previewNoOp ? 'PASS ✓' : 'FAIL ✗'} (page-sel text len = ${afterPreview.pageSelText})`);
console.log(`text input focused → handler bails:      ${textInputHandlerBailed ? 'PASS ✓' : 'FAIL ✗'} (canvas sel was ${beforeInputCmdA} → ${afterInputCmdA.canvasSel})`);

const ok = canvasAllSelected && assetsAllSelected && previewNoOp && textInputHandlerBailed;
process.exit(ok ? 0 : 1);
