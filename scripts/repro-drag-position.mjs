// Drag-position repro: confirms what fires when a node's position
// changes but nothing else does. Drives commitActivePositions directly
// (== what onNodeDragStop hands to the store at end-of-drag).

import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox',
  ],
});
const page = await browser.newPage();

const logs = [];
page.on('console', async (msg) => {
  const parts = await Promise.all(
    msg.args().map(async (arg) => {
      try { return await arg.evaluate((v) => typeof v === 'string' ? v : JSON.stringify(v)); }
      catch { return String(arg); }
    }),
  );
  logs.push(parts.join(' '));
});

await page.goto('http://localhost:8080/?debug=1', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

// Load Tree & Bush, navigate into bark-texture, wait for initial paint.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate(() => {
  globalThis.__DEBUG_SCENE_PREVIEW__ = true;
  window.__sedonStore__.getState().setActiveEditing('bark-texture');
});
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  console.log('=== FIRST commit position change ===');
  const state = window.__sedonStore__.getState();
  const n = state.graph.nodes[0];
  state.commitActivePositions(new Map([[n.id, { x: n.position.x + 50, y: n.position.y + 50 }]]));
});
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  console.log('=== SECOND commit position change (steady state) ===');
  const state = window.__sedonStore__.getState();
  const n = state.graph.nodes[0];
  state.commitActivePositions(new Map([[n.id, { x: n.position.x + 30, y: n.position.y + 30 }]]));
});
await new Promise((r) => setTimeout(r, 2000));

console.log('\n========== CAPTURED LOG ==========\n');
for (const line of logs) console.log(line);
await browser.close();
