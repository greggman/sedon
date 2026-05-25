// Canvas + Preview tab titles reflect the graph they're showing.
// Verifies:
//   1. With main graph active, both tabs show "Main".
//   2. After loading a demo with subgraphs and switching the active
//      editing graph, the (unpinned) canvas tab follows.
//   3. Pinning a Preview to a specific subgraph makes its tab show
//      that subgraph's label — even when canvas is showing a different
//      graph.
//   4. Renaming a subgraph live-updates the corresponding tab.

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

// Helper: read the title text of the canvas / preview / assets tabs.
// DockView renders tabs as `.dv-default-tab .dv-default-tab-content`
// inside the tab strip. Find each one by walking up from the panel
// content element (each panel content is wrapped in dv-content with
// data-attribute) — easier path: ask DockView via its API.
const readTabs = () => page.evaluate(() => {
  const api = window.__sedonGetDockview__?.() ?? null;
  if (!api) return null;
  const out = {};
  for (const p of api.panels) {
    out[p.id] = p.title;
  }
  return out;
});

// Seed: load forest (has main + several subgraphs).
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 600));

const initial = await readTabs();
console.log('initial tab titles:', initial);

// Switch the active editing graph to grass-texture. The unpinned canvas
// should follow (its title becomes the grass-texture label).
await page.evaluate(() => {
  window.__sedonStore__.getState().setActiveEditing('grass-texture');
});
await new Promise((r) => setTimeout(r, 300));
const afterSwitchEditing = await readTabs();
console.log('after setActiveEditing(grass-texture):', afterSwitchEditing);

// Pin the preview to 'oak-tree'. Preview tab should now read its label,
// independent of canvas's title.
await page.evaluate(() => {
  window.__sedonLayoutStore__.getState().setPanelPinnedGraph('preview-main', 'oak-tree');
});
await new Promise((r) => setTimeout(r, 200));
const afterPinPreview = await readTabs();
console.log('after pinning preview to oak-tree:', afterPinPreview);

// Rename grass-texture → "Test Renamed". Canvas tab should update.
await page.evaluate(() => {
  window.__sedonStore__.getState().renameSubgraph('grass-texture', 'Test Renamed');
});
await new Promise((r) => setTimeout(r, 200));
const afterRename = await readTabs();
console.log('after rename:', afterRename);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const canvasInitiallyMain = initial?.['canvas-main'] === 'Main';
const previewInitiallyMain = initial?.['preview-main'] === 'Main';
const assetsStayedAssets = initial?.['assets-main'] === 'Assets';
const canvasFollowsEditing = afterSwitchEditing?.['canvas-main'] === 'Grass Texture';
const previewPinnedShown = afterPinPreview?.['preview-main'] === 'Oak Tree';
const canvasUnaffectedByPreviewPin = afterPinPreview?.['canvas-main'] === 'Grass Texture';
const canvasReflectsRename = afterRename?.['canvas-main'] === 'Test Renamed';
const previewUnaffectedByRename = afterRename?.['preview-main'] === 'Oak Tree';

console.log(`canvas tab "Main" at start:                  ${canvasInitiallyMain ? 'PASS ✓' : 'FAIL ✗'} (${initial?.['canvas-main']})`);
console.log(`preview tab "Main" at start:                 ${previewInitiallyMain ? 'PASS ✓' : 'FAIL ✗'} (${initial?.['preview-main']})`);
console.log(`assets tab stays "Assets":                   ${assetsStayedAssets ? 'PASS ✓' : 'FAIL ✗'} (${initial?.['assets-main']})`);
console.log(`canvas tab follows active editing:           ${canvasFollowsEditing ? 'PASS ✓' : 'FAIL ✗'} (${afterSwitchEditing?.['canvas-main']})`);
console.log(`pinning preview updates only preview tab:    ${previewPinnedShown && canvasUnaffectedByPreviewPin ? 'PASS ✓' : 'FAIL ✗'} (canvas=${afterPinPreview?.['canvas-main']}, preview=${afterPinPreview?.['preview-main']})`);
console.log(`renaming a subgraph updates the tab title:   ${canvasReflectsRename ? 'PASS ✓' : 'FAIL ✗'} (${afterRename?.['canvas-main']})`);
console.log(`renaming one graph doesn't touch the other:  ${previewUnaffectedByRename ? 'PASS ✓' : 'FAIL ✗'} (preview=${afterRename?.['preview-main']})`);

const ok = canvasInitiallyMain && previewInitiallyMain && assetsStayedAssets
  && canvasFollowsEditing && previewPinnedShown && canvasUnaffectedByPreviewPin
  && canvasReflectsRename && previewUnaffectedByRename;
process.exit(ok ? 0 : 1);
