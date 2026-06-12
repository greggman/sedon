// Repro: 1) open scene=basic, 2) select tex/grid, 3) Extract To Subgraph,
// 4) Edit the new subgraph, 5) Delete tex/grid → app crashes with TypeError.

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
const errors = [];
page.on('pageerror', (e) => { errors.push(`pageerror: ${e.message}`); console.log('[pageerror]', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(`console: ${msg.text()}`);
    console.log('[console.error]', msg.text());
  }
});

await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => typeof window.__sedonStore__ === 'function' &&
        window.__sedonStore__.getState().graph.nodes.length > 0,
  { timeout: 10000 },
);

// Step 1: find tex/grid id, select it via RF.
const gridId = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return s.graph.nodes.find((n) => n.kind === 'tex/grid')?.id ?? null;
});
console.log('tex/grid id:', gridId);
if (!gridId) throw new Error('no tex/grid');

await page.evaluate((id) => {
  const rf = window.__sedonGetActiveRf__?.();
  rf?.setNodes((nodes) => nodes.map((n) => ({ ...n, selected: n.id === id })));
}, gridId);
await new Promise((r) => setTimeout(r, 200));

// Step 2: open command palette → run Selection: Extract to Subgraph.
console.log('[step] extracting via palette');
await page.keyboard.down('Meta');
await page.keyboard.down('Shift');
await page.keyboard.press('p');
await page.keyboard.up('Shift');
await page.keyboard.up('Meta');
await page.waitForSelector('.sedon-palette-input, .sedon-palette-row', { timeout: 5000 }).catch(() => null);
await page.keyboard.type('Extract');
await new Promise((r) => setTimeout(r, 200));
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 800));

// Step 3: identify the new subgraph and open it.
const newSubgraph = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return s.subgraphs.at(-1)?.id ?? null;
});
console.log('new subgraph id:', newSubgraph);
if (!newSubgraph) {
  console.log('extract did not produce a subgraph; errors so far:', errors);
  await browser.close();
  await server.close();
  process.exit(1);
}

await page.evaluate((sgId) => {
  window.__sedonOpenGraphInCanvas__?.(sgId);
}, newSubgraph);
await new Promise((r) => setTimeout(r, 600));

// Step 4: confirm tex/grid lives in the subgraph, then delete it.
const inside = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return {
    currentEditingId: s.currentEditingId,
    nodeIds: s.graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
  };
});
console.log('subgraph state:', JSON.stringify(inside, null, 2));

const innerGridId = inside.nodeIds.find((n) => n.kind === 'tex/grid')?.id;
console.log('inner tex/grid id:', innerGridId);
if (!innerGridId) {
  console.log('no tex/grid inside subgraph?!');
  await browser.close();
  await server.close();
  process.exit(1);
}

console.log('[step] deleting tex/grid inside subgraph');
try {
  await page.evaluate((id) => {
    window.__sedonStore__.getState().removeNodes(new Set([id]));
  }, innerGridId);
  await new Promise((r) => setTimeout(r, 800));
  console.log('[ok] delete dispatched');
} catch (e) {
  console.log('[err] delete threw:', e.message);
}

console.log('---- final error list ----');
for (const err of errors) console.log(err);

await browser.close();
await server.close();
