// Test that switching scenes (demos AND preview-pin dropdown) updates
// the Preview camera to the right per-scene framing.

import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', async (msg) => {
  const parts = await Promise.all(
    msg.args().map(async (arg) => {
      try { return await arg.evaluate((v) => (typeof v === 'string' ? v : JSON.stringify(v))); }
      catch { return String(arg); }
    }),
  );
  logs.push(`[${msg.type()}] ${parts.join(' ')}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:8080/?debug=1', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await page.evaluate(() => { globalThis.__DEBUG_SCENE_PREVIEW__ = true; });

const readCameraLog = () => {
  const draws = logs.filter((l) => l.includes('[PreviewTile draw]'));
  return draws[draws.length - 1] ?? '(no draw log yet)';
};

// ====== STEP 1: Load Forest ======
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  // setGraph internally resets the layout-store (per-graph session
  // slices) before applying the new project, so we don't need to
  // call resetForNewProject explicitly. Same code path the demos
  // menu uses in production.
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER forest load:    ', readCameraLog());

// ====== STEP 2: Switch to Tree-Bush demo ======
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  // setGraph internally resets the layout-store (per-graph session
  // slices) before applying the new project, so we don't need to
  // call resetForNewProject explicitly. Same code path the demos
  // menu uses in production.
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER tree-bush load: ', readCameraLog());

// ====== STEP 3: Switch back to Forest ======
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  // setGraph internally resets the layout-store (per-graph session
  // slices) before applying the new project, so we don't need to
  // call resetForNewProject explicitly. Same code path the demos
  // menu uses in production.
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER forest reload:  ', readCameraLog());

// ====== STEP 4: Within Forest, pin to Oak Tree via the preview dropdown ======
// Use __sedonOpenGraphInPreview__ which simulates clicking the asset/dropdown.
await page.evaluate(() => {
  window.__sedonOpenGraphInPreview__('oak-tree');
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER pin oak-tree:   ', readCameraLog());

// ====== STEP 5: Pin back to main ======
await page.evaluate(() => {
  window.__sedonOpenGraphInPreview__('main');
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER pin main:       ', readCameraLog());

// ====== STEP 6: simulate a user-drag in the Preview pane to commit
//                a panelCamera, then switch demos. Does the new demo's
//                framing take over, or does the saved drag persist?
const previewBox = await page.evaluate(() => {
  const el = document.querySelector('.sedon-preview-pane');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (previewBox) {
  await page.mouse.move(previewBox.x, previewBox.y);
  await page.mouse.down();
  await page.mouse.move(previewBox.x + 80, previewBox.y - 40, { steps: 8 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 500));
  console.log('AFTER user drag:      ', readCameraLog());
}

// ====== STEP 7: switch demos AFTER a drag committed a panelCamera ======
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  // setGraph internally resets the layout-store (per-graph session
  // slices) before applying the new project, so we don't need to
  // call resetForNewProject explicitly. Same code path the demos
  // menu uses in production.
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER switch to tree: ', readCameraLog());

// ====== STEP 8: pin to a subgraph that we have NOT pinned before
//                (e.g. tree-bush has oak-leaf) ======
await page.evaluate(() => {
  window.__sedonOpenGraphInPreview__('oak-leaf');
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER pin oak-leaf:   ', readCameraLog());

// ====== STEP 9: switch back to forest demo ======
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  // setGraph internally resets the layout-store (per-graph session
  // slices) before applying the new project, so we don't need to
  // call resetForNewProject explicitly. Same code path the demos
  // menu uses in production.
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
console.log('AFTER forest re-load2:', readCameraLog());

await browser.close();

console.log('\n========== EXPECTED (per forest demo) ==========');
console.log('  main:     yaw=0.400 pitch=0.450 dist=95.000 target=[0,8,0]');
console.log('  oak-tree: yaw=0.500 pitch=0.250 dist=35.000 target=[0,10,0]');
console.log('\n========== EXPECTED (per tree-bush demo) ==========');
console.log('  main:     (whatever tree-bush specifies, often ~3m default)');
