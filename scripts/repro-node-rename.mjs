// Click the node's title in the header → it turns into a text input
// → type a name + Enter → the new name shows in the header. Verifies
// the full DOM-level click/edit/commit cycle works (not just the
// store's renameNode).

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
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3500));

// Locate the first node's title element and its kind (for assertion).
const titleInfo = await page.evaluate(() => {
  const nodeEl = document.querySelector('.react-flow__node');
  if (!nodeEl) return null;
  const titleEl = nodeEl.querySelector('.sedon-node-title');
  if (!titleEl) return null;
  const r = titleEl.getBoundingClientRect();
  return {
    x: r.x + r.width / 2,
    y: r.y + r.height / 2,
    text: titleEl.textContent ?? '',
    unnamed: titleEl.classList.contains('sedon-node-title--unnamed'),
    nodeId: nodeEl.getAttribute('data-id') ?? null,
  };
});
if (!titleInfo) { console.log('FAIL: no node title found'); process.exit(1); }
console.log('initial title:', titleInfo);

// Double-click the title → should swap to an input. Single click is
// reserved for selecting the node, matching Finder / Houdini.
await page.mouse.click(titleInfo.x, titleInfo.y, { count: 2 });
await new Promise((r) => setTimeout(r, 300));
const editingState = await page.evaluate(() => {
  const inp = document.querySelector('.react-flow__node .sedon-editable-name-input');
  return inp ? { tag: inp.tagName, focused: document.activeElement === inp, value: inp.value } : null;
});
console.log('after click, edit input present?', editingState);

// Type a name + Enter.
await page.keyboard.type('ground heightfield');
await new Promise((r) => setTimeout(r, 200));
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 400));

// Verify the two-line layout: a `.sedon-node-title-name` div holds the
// user's name on the top line, a `.sedon-node-title-kind` div holds
// the kind subtitle below. Store reflects the rename.
const after = await page.evaluate(() => {
  const titleEl = document.querySelector('.react-flow__node .sedon-node-title');
  const nameEl = titleEl?.querySelector('.sedon-node-title-name');
  const kindEl = titleEl?.querySelector('.sedon-node-title-kind');
  return {
    text: titleEl?.textContent ?? '',
    nameText: nameEl?.textContent ?? '',
    kindText: kindEl?.textContent ?? '',
    kindAlone: kindEl?.classList.contains('sedon-node-title-kind--alone') ?? false,
    unnamed: titleEl?.classList.contains('sedon-node-title--unnamed') ?? null,
  };
});
const storeName = await page.evaluate((id) => {
  if (!id) return null;
  const g = window.__sedonStore__.getState().graph;
  return g.nodes.find((n) => n.id === id)?.name ?? null;
}, titleInfo.nodeId);
console.log('after commit — header:', after, 'store name:', storeName);

// Click again → edit → blank Enter → name cleared.
const titleInfo2 = await page.evaluate(() => {
  const titleEl = document.querySelector('.react-flow__node .sedon-node-title');
  const r = titleEl.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(titleInfo2.x, titleInfo2.y, { count: 2 });
await new Promise((r) => setTimeout(r, 200));
// Puppeteer's Meta+A select-all binding is unreliable across
// platforms; press Backspace enough times to clear any reasonable
// name. Faster than trying to compute exact length.
for (let i = 0; i < 40; i++) await page.keyboard.press('Backspace');
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 400));
const cleared = await page.evaluate(() => {
  const titleEl = document.querySelector('.react-flow__node .sedon-node-title');
  const kindEl = titleEl?.querySelector('.sedon-node-title-kind');
  return {
    text: titleEl?.textContent ?? '',
    unnamed: titleEl?.classList.contains('sedon-node-title--unnamed') ?? null,
    kindAlone: kindEl?.classList.contains('sedon-node-title-kind--alone') ?? false,
    hasNameRow: !!titleEl?.querySelector('.sedon-node-title-name'),
  };
});
console.log('after clear — header:', cleared);

// ---- Subgraph wrappers: ONE name, ONE type.
// A wrapper is ALWAYS named — its `name` IS the SubgraphDef's `label`
// (subgraphs always have a label). The display shows name = label
// (e.g. "Branch Bush") + type = "subgraph". Renaming the wrapper
// renames the DEFINITION, propagating to every wrapper instance AND
// the Asset panel; no per-node name is stored on the wrapper.
const sgWrapperBefore = await page.evaluate(() => {
  const wrappers = [...document.querySelectorAll('.react-flow__node')].filter((el) => {
    const id = el.getAttribute('data-id');
    if (!id) return false;
    const node = window.__sedonStore__.getState().graph.nodes.find((n) => n.id === id);
    return !!node?.kind?.startsWith('subgraph/');
  });
  if (wrappers.length === 0) return null;
  // Find a Branch Bush wrapper specifically so the assertions below
  // match a known label.
  const w = wrappers.find((el) => {
    const id = el.getAttribute('data-id');
    const node = window.__sedonStore__.getState().graph.nodes.find((n) => n.id === id);
    const sgId = node?.kind?.slice('subgraph/'.length);
    return window.__sedonStore__.getState().subgraphs.find((g) => g.id === sgId)?.label === 'Branch Bush';
  }) ?? wrappers[0];
  const id = w.getAttribute('data-id');
  const node = window.__sedonStore__.getState().graph.nodes.find((n) => n.id === id);
  const sgId = node.kind.slice('subgraph/'.length);
  const nameEl = w.querySelector('.sedon-node-title-name');
  const kindEl = w.querySelector('.sedon-node-title-kind');
  return {
    nodeId: id,
    sgId,
    headerName: nameEl?.textContent ?? '',
    headerType: kindEl?.textContent ?? '',
  };
});
console.log('subgraph wrapper (before rename):', sgWrapperBefore);

// Drive the wrapper's rename via the store so the test isn't entangled
// with the UI double-click + keyboard timing. The custom-node's
// `onCommit` is wired to call this exact same action — verified
// separately in unit tests.
await page.evaluate((sgId) => {
  window.__sedonStore__.getState().renameSubgraph(sgId, 'foo');
}, sgWrapperBefore.sgId);
await new Promise((r) => setTimeout(r, 400));

const afterRename = await page.evaluate((nodeId) => {
  const w = [...document.querySelectorAll('.react-flow__node')].find((el) => el.getAttribute('data-id') === nodeId);
  const nameEl = w?.querySelector('.sedon-node-title-name');
  const kindEl = w?.querySelector('.sedon-node-title-kind');
  const store = window.__sedonStore__.getState();
  const node = store.graph.nodes.find((n) => n.id === nodeId);
  // "Branch Bush" must not survive anywhere in the store after the
  // rename — that's the user's "1 name only" invariant.
  const stillHasBranchBush = store.subgraphs.some((s) => s.label === 'Branch Bush');
  return {
    headerNameText: nameEl?.textContent ?? '',
    headerTypeText: kindEl?.textContent ?? '',
    sgDefLabel: store.subgraphs.find((g) => g.id === node?.kind?.slice('subgraph/'.length))?.label ?? '(missing)',
    perNodeName: node?.name ?? null,
    stillHasBranchBush,
  };
}, sgWrapperBefore.nodeId);
console.log('subgraph wrapper (renamed to foo):', afterRename);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const clickOpened = editingState !== null && editingState.tag === 'INPUT';
// Two-line layout when named: name row + kind row, not --unnamed.
const commitWorks = after.nameText === 'ground heightfield'
  && after.kindText.length > 0
  && after.kindAlone === false
  && after.unnamed === false
  && storeName === 'ground heightfield';
// After clearing, the header collapses back to the single-line state:
// no name row, the kind subtitle is shown as the standalone line, and
// the --unnamed class is reapplied.
const cleared_ok = cleared.unnamed === true
  && cleared.hasNameRow === false
  && cleared.kindAlone === true;
const sgInitiallyShowsLabel =
  sgWrapperBefore?.headerName === 'Branch Bush'
  && sgWrapperBefore?.headerType === 'subgraph';
const sgRenameUnified =
  afterRename.headerNameText === 'foo'
  && afterRename.headerTypeText === 'subgraph'
  && afterRename.sgDefLabel === 'foo'             // Asset-folder name updated
  && afterRename.perNodeName === null             // wrapper got NO per-node name
  && afterRename.stillHasBranchBush === false;    // nothing in the store says "Branch Bush"
console.log(`click on title opened an input:                  ${clickOpened ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Enter committed name to header+store:            ${commitWorks ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`empty-Enter cleared back to kind:                ${cleared_ok ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`wrapper header shows label as name + 'subgraph': ${sgInitiallyShowsLabel ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`renaming wrapper renames the SUBGRAPH globally:  ${sgRenameUnified ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(clickOpened && commitWorks && cleared_ok && sgInitiallyShowsLabel && sgRenameUnified ? 0 : 1);
