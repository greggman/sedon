// Right-click context menu on the preview: should show Frame /
// View-in-Canvas options derived from the picked entity's provenance
// chain. Verifies:
//   1. Right-click over a tree opens a menu containing both "Frame ..."
//      items (with a #N point index) and "View ... in Canvas" items.
//   2. Clicking a Frame item moves the camera.
//   3. Clicking a "View ⟨subgraph⟩ in Canvas" item flips the editor
//      store's currentEditingId to that subgraph.
//   4. Right-click over the sky still offers "Frame Scene" and "View
//      Main in Canvas" (no scattered-entity items).

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

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 4000));

const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-preview-canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
if (!rect) { console.log('FAIL: no preview canvas'); process.exit(1); }
const cx = rect.x + rect.w * 0.5;
const cy = rect.y + rect.h * 0.6; // tree-ish
const skyX = rect.x + rect.w * 0.5;
const skyY = rect.y + 8;

// Read the menu items currently rendered (label + primary).
async function menuItems() {
  return page.evaluate(() => {
    const menu = document.querySelector('.sedon-assets-context-menu');
    if (!menu) return null;
    return [...menu.querySelectorAll('.sedon-assets-context-menu-item')].map((b) => ({
      label: b.textContent ?? '',
      primary: parseInt(b.style.fontWeight ?? '0', 10) >= 600,
    }));
  });
}

// Click the first menu item matching `regex`. Returns true if clicked.
async function clickItem(regex) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const btn = [...document.querySelectorAll('.sedon-assets-context-menu .sedon-assets-context-menu-item')]
      .find((b) => re.test(b.textContent ?? ''));
    if (!btn) return false;
    btn.click();
    return true;
  }, regex.source);
}

const readCam = () => page.evaluate(() => {
  const lay = window.__sedonLayoutStore__.getState();
  const panelId = lay.lastActivePreviewPanelId ?? Object.keys(lay.previewCameras)[0];
  return (panelId && lay.previewCameras[panelId]?.main)
    ?? lay.recentPreviewCameras?.main ?? null;
});
const readEditing = () => page.evaluate(() => window.__sedonStore__.getState().currentEditingId);

// Focus the preview wrapper so keyboard / pointer focus works.
await page.mouse.click(cx, cy);
await new Promise((r) => setTimeout(r, 300));

// ----- 1. Right-click over a tree → menu contains Frame + View items.
// Inspect the menu's items, but DON'T click "Frame" yet — we need the
// camera to stay where it is for the sky / View-in-Canvas tests.
await page.mouse.click(cx, cy, { button: 'right' });
await new Promise((r) => setTimeout(r, 800));
const treeMenu = await menuItems();
console.log('TREE menu items:');
treeMenu?.forEach((it) => console.log('  ', it.primary ? '★' : ' ', it.label));

const hasFrameTree = treeMenu?.some((i) => /^Frame .* #\d+$/.test(i.label));
const hasViewSub  = treeMenu?.some((i) => /^View .+ in Canvas$/.test(i.label) && !/View Main/.test(i.label));
const hasFrameScene = treeMenu?.some((i) => i.label === 'Frame Scene');
const hasViewMain   = treeMenu?.some((i) => i.label === 'View Main in Canvas');

// ----- 2. Click "View ⟨subgraph⟩ in Canvas" — must change editing context.
const editingBefore = await readEditing();
const viewClicked = await clickItem(/^View (?!Main).+ in Canvas$/);
await new Promise((r) => setTimeout(r, 400));
const editingAfter = await readEditing();
console.log(`currentEditingId: ${editingBefore} → ${editingAfter}`);

// ----- 3. Right-click sky (camera still at the demo default) → menu
// must NOT have per-instance Frame items, only Frame Scene + View Main.
await page.mouse.click(skyX, skyY, { button: 'right' });
await new Promise((r) => setTimeout(r, 800));
const skyMenu = await menuItems();
console.log('SKY menu items:');
skyMenu?.forEach((it) => console.log('  ', it.primary ? '★' : ' ', it.label));
const skyHasFrameScene = skyMenu?.some((i) => i.label === 'Frame Scene');
const skyHasViewMain = skyMenu?.some((i) => i.label === 'View Main in Canvas');
const skyNoInstanceFrame = !skyMenu?.some((i) => /^Frame .* #\d+$/.test(i.label));

// Close the sky menu before the Frame test.
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 200));

// ----- 4. Click the primary Frame item → camera should move.
const camBefore = await readCam();
await page.mouse.click(cx, cy, { button: 'right' });
await new Promise((r) => setTimeout(r, 800));
const clickedFrame = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.sedon-assets-context-menu-item')];
  const primary = items.find((b) => parseInt(b.style.fontWeight ?? '0', 10) >= 600);
  if (!primary) return false;
  primary.click();
  return true;
});
void clickedFrame;
await new Promise((r) => setTimeout(r, 800));
const camAfter = await readCam();
console.log('camera before frame:', camBefore && { target: camBefore.target, distance: camBefore.distance.toFixed(2) });
console.log('camera after frame: ', camAfter && { target: camAfter.target, distance: camAfter.distance.toFixed(2) });

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
console.log(`tree menu has 'Frame ⟨name⟩ #N':        ${hasFrameTree ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`tree menu has 'View ⟨subgraph⟩ ...':    ${hasViewSub ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`tree menu has 'Frame Scene':             ${hasFrameScene ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`tree menu has 'View Main in Canvas':     ${hasViewMain ? 'PASS ✓' : 'FAIL ✗'}`);
const moved = camBefore && camAfter && (
  Math.hypot(
    camAfter.target[0] - camBefore.target[0],
    camAfter.target[1] - camBefore.target[1],
    camAfter.target[2] - camBefore.target[2],
  ) > 0.5 || Math.abs(camAfter.distance - camBefore.distance) > 0.5
);
console.log(`primary Frame moved camera:              ${moved ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`View ⟨...⟩ clicked + opened (editing):   ${viewClicked && editingAfter !== editingBefore ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`sky menu still has Frame Scene:          ${skyHasFrameScene ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`sky menu still has View Main in Canvas:  ${skyHasViewMain ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`sky menu HAS NO 'Frame ⟨name⟩ #N':       ${skyNoInstanceFrame ? 'PASS ✓' : 'FAIL ✗'}`);
const all = hasFrameTree && hasViewSub && hasFrameScene && hasViewMain && moved
  && viewClicked && editingAfter !== editingBefore
  && skyHasFrameScene && skyHasViewMain && skyNoInstanceFrame;
process.exit(all ? 0 : 1);
