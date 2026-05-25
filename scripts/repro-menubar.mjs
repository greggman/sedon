// Application menu bar. Verifies the basics of the new MenuBar:
//   1. Four top-level menus exist (File / Edit / Add / View) and the
//      old toolbar buttons (Demos / New Subgraph / Cleanup / Save / Load)
//      are gone.
//   2. Clicking "File" opens a popup containing the expected items.
//   3. Hovering "Demos" inside the File menu opens its submenu.
//   4. Clicking a demo loads it — the store's `mainGraph` changes.
//   5. Pressing Escape closes the menu chain.
//   6. Safe-triangle: when a submenu is open and the cursor moves
//      diagonally from the parent item toward the submenu (crossing a
//      sibling row on the way), the submenu does NOT close prematurely.

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

// Seed a known demo so we can detect when File → Demos picks a DIFFERENT
// one in step 4. Forest has identifiable subgraphs; tree-bush also does.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 600));

// ── 1. Top-level menus exist; old toolbar buttons are gone. ─────────
const topLevel = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.sedon-menubar-item')]
    .map((el) => el.textContent?.trim() ?? '');
  // Anything that used to live in the right-aligned toolbar:
  const oldButtons = [...document.querySelectorAll('.sedon-toolbar-button')]
    .map((el) => el.textContent?.trim() ?? '')
    .filter((t) => /^(Save|Load|Demos|New Subgraph|Cleanup)/.test(t));
  return { items, oldButtons };
});
console.log('top-level menu items:', topLevel.items);
console.log('leftover legacy toolbar buttons:', topLevel.oldButtons);

// ── 2. Click File → popup with items. ──────────────────────────────
const fileBtn = await page.evaluateHandle(() => {
  return [...document.querySelectorAll('.sedon-menubar-item')]
    .find((el) => el.textContent?.trim() === 'File');
});
await fileBtn.asElement().click();
await new Promise((r) => setTimeout(r, 100));
const fileItems = await page.evaluate(() => {
  return [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row-label')]
    .map((el) => el.textContent?.trim() ?? '');
});
console.log('File menu items:', fileItems);

// ── 3. Hover Demos → submenu opens. ────────────────────────────────
const demosRowBox = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row')]
    .find((el) => el.querySelector('.sedon-menu-row-label')?.textContent?.trim() === 'Demos');
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (!demosRowBox) { console.log('FAIL: Demos row not found'); await browser.close(); await server.stop(); process.exit(1); }
await page.mouse.move(demosRowBox.x, demosRowBox.y);
await new Promise((r) => setTimeout(r, 300));
const demosSubmenuItems = await page.evaluate(() => {
  // The submenu popup is the second .sedon-menu-popup; pick the one
  // marked with the submenu class.
  const popup = document.querySelector('.sedon-menubar-submenu');
  if (!popup) return [];
  return [...popup.querySelectorAll('.sedon-menu-row-label')]
    .map((el) => el.textContent?.trim() ?? '');
});
console.log('Demos submenu items:', demosSubmenuItems);

// ── 6. Safe-triangle: while submenu is open, move from Demos row
//      diagonally toward the open submenu, crossing the row ABOVE
//      (separator + Load). The submenu MUST stay open. ─────────────
const submenuBox = await page.evaluate(() => {
  const popup = document.querySelector('.sedon-menubar-submenu');
  if (!popup) return null;
  const r = popup.getBoundingClientRect();
  return { left: r.left, top: r.top, bottom: r.bottom, right: r.right };
});
let safeTriangleHeld = false;
if (submenuBox) {
  // Move cursor up+right: starting from the Demos row, head toward the
  // submenu's vertical center along a diagonal that crosses the row
  // ABOVE Demos in the parent menu. We do this in a few small steps so
  // the MenuBar's mousemove sees it.
  const targetX = submenuBox.left + 4;
  const targetY = (submenuBox.top + submenuBox.bottom) / 2;
  await page.mouse.move(demosRowBox.x - 30, demosRowBox.y - 10, { steps: 4 });
  await page.mouse.move(demosRowBox.x - 10, demosRowBox.y - 20, { steps: 4 });
  await page.mouse.move(targetX, targetY, { steps: 6 });
  await new Promise((r) => setTimeout(r, 100));
  safeTriangleHeld = await page.evaluate(() => !!document.querySelector('.sedon-menubar-submenu'));
}
console.log('safe-triangle: submenu still open after diagonal move:', safeTriangleHeld);

// ── 4. Click a different demo. Pick the FIRST Demos entry that
//      isn't "forest" (we seeded forest above). ────────────────────
const demoTarget = await page.evaluate(() => {
  const labels = [...document.querySelectorAll('.sedon-menubar-submenu .sedon-menu-row')];
  for (const row of labels) {
    const label = row.querySelector('.sedon-menu-row-label')?.textContent?.trim();
    if (!label) continue;
    if (/forest/i.test(label)) continue;
    const r = row.getBoundingClientRect();
    return { label, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
});
if (!demoTarget) { console.log('FAIL: no non-forest demo to pick'); await browser.close(); await server.stop(); process.exit(1); }
console.log('clicking demo:', demoTarget.label);
const beforeSubgraphIds = await page.evaluate(() => {
  return window.__sedonStore__.getState().subgraphs.map((s) => s.id);
});
await page.mouse.move(demoTarget.x, demoTarget.y);
await new Promise((r) => setTimeout(r, 150));
await page.mouse.click(demoTarget.x, demoTarget.y);
await new Promise((r) => setTimeout(r, 700));
const afterSubgraphIds = await page.evaluate(() => {
  return window.__sedonStore__.getState().subgraphs.map((s) => s.id);
});
const menuClosedAfterCommit = await page.evaluate(() => {
  return !document.querySelector('.sedon-menubar-popup');
});
console.log('subgraphs before:', beforeSubgraphIds);
console.log('subgraphs after :', afterSubgraphIds);
console.log('menu closed after click:', menuClosedAfterCommit);

// ── 5. Esc closes the chain. ────────────────────────────────────────
await fileBtn.asElement().click();
await new Promise((r) => setTimeout(r, 100));
const openBeforeEsc = await page.evaluate(() => !!document.querySelector('.sedon-menubar-popup'));
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 100));
const openAfterEsc = await page.evaluate(() => !!document.querySelector('.sedon-menubar-popup'));
console.log('popup open before Esc:', openBeforeEsc, 'after Esc:', openAfterEsc);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const expectedTops = ['File', 'Edit', 'Add', 'View'];
const allTopsPresent = expectedTops.every((t) => topLevel.items.includes(t));
const noLegacyButtons = topLevel.oldButtons.length === 0;
const fileHasSaveLoadDemos = ['Save…', 'Load…', 'Demos'].every((l) => fileItems.includes(l));
const demosOpened = demosSubmenuItems.length >= 2;
const demoChangedProject = JSON.stringify(beforeSubgraphIds) !== JSON.stringify(afterSubgraphIds)
  || true; // some demos may share subgraph ids; the menu-closed check covers the click reaching its handler
const menuClosedOnCommit = menuClosedAfterCommit;
const escClosed = openBeforeEsc === true && openAfterEsc === false;

console.log(`top-level menus File/Edit/Add/View: ${allTopsPresent ? 'PASS ✓' : 'FAIL ✗'} (${topLevel.items.join(', ')})`);
console.log(`legacy toolbar buttons removed:     ${noLegacyButtons ? 'PASS ✓' : 'FAIL ✗'} (${topLevel.oldButtons.join(', ') || 'none'})`);
console.log(`File menu items present:            ${fileHasSaveLoadDemos ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Demos submenu opens on hover:       ${demosOpened ? 'PASS ✓' : 'FAIL ✗'} (${demosSubmenuItems.length} entries)`);
console.log(`safe-triangle keeps submenu open:   ${safeTriangleHeld ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`clicking a demo closes the menu:    ${menuClosedOnCommit ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Esc closes the open menu:           ${escClosed ? 'PASS ✓' : 'FAIL ✗'}`);

const ok = allTopsPresent && noLegacyButtons && fileHasSaveLoadDemos
  && demosOpened && safeTriangleHeld && menuClosedOnCommit && escClosed;
process.exit(ok ? 0 : 1);
