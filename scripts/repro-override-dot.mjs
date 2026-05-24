// Per-input override indicator + reset gesture.
// Verifies end-to-end:
//   1. A row with NO override has an invisible dot (the `.sedon-override-dot`
//      placeholder, no `--set` modifier).
//   2. Setting an override via the store flips the dot to `--set` (teal,
//      interactive).
//   3. Clicking the dot dispatches setInputValue(undefined), which
//      removes the key from inputValues, and the dot reverts to
//      invisible — without removing other unrelated overrides.

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
await new Promise((r) => setTimeout(r, 3500));

// Sanity check: regular (non-subgraph) nodes must NOT render any
// dot. core/perlin is a regular node — its rows should have ZERO
// .sedon-override-dot elements.
const regularNodeDots = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const perlin = state.mainGraph.nodes.find((n) => n.kind === 'core/perlin');
  if (!perlin) return null;
  const el = document.querySelector(`.react-flow__node[data-id="${perlin.id}"]`);
  return el ? el.querySelectorAll('.sedon-override-dot').length : null;
});
console.log('dot count on a regular (perlin) node:', regularNodeDots);

// Now find a SUBGRAPH WRAPPER node — that's where the dot belongs.
const target = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const wrapper = state.mainGraph.nodes.find((n) => n.kind?.startsWith('subgraph/'));
  if (!wrapper) return null;
  const sgId = wrapper.kind.slice('subgraph/'.length);
  const sg = state.subgraphs.find((g) => g.id === sgId);
  // Need at least one unwired input we can override on this wrapper.
  const connectedTargets = new Set(state.mainGraph.edges
    .filter((e) => e.to.node === wrapper.id)
    .map((e) => e.to.socket));
  const inp = sg?.inputs.find((i) =>
    !connectedTargets.has(i.name)
    && (i.type === 'Float' || i.type === 'Int' || i.type === 'Color' || i.type === 'Vec3'),
  );
  return inp ? { nodeId: wrapper.id, kind: wrapper.kind, inputName: inp.name } : null;
});
if (!target) { console.log('FAIL: no subgraph wrapper with unwired editable input'); process.exit(1); }
console.log('targeting wrapper:', target);
const inputName = target.inputName;

// Helper: inspect the override dot for this row.
const inspectDot = () => page.evaluate(({ nodeId, name }) => {
  const nodeEl = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (!nodeEl) return null;
  // The dot lives inside the row whose label matches `name`. Walk rows.
  const rows = [...nodeEl.querySelectorAll('.sedon-node-row')];
  for (const r of rows) {
    const label = r.querySelector('.sedon-node-label')?.textContent ?? '';
    if (label === name || label === name.replace(/_/g, ' ')) {
      const dot = r.querySelector('.sedon-override-dot');
      const rect = dot?.getBoundingClientRect();
      return {
        present: !!dot,
        setClass: dot?.classList.contains('sedon-override-dot--set') ?? false,
        bg: dot ? getComputedStyle(dot).backgroundColor : '',
        clickX: rect ? rect.x + rect.width / 2 : null,
        clickY: rect ? rect.y + rect.height / 2 : null,
      };
    }
  }
  return null;
}, { nodeId: target.nodeId, name: inputName });

// Demos may seed inputValues (forest sets perlin.scale), so the dot
// could start in the `--set` state. Reset first to get to a known
// "default" baseline. The reset itself is what we're partially
// testing: setInputValue(undefined) must clear the key AND flip the
// dot's visual state.
await page.evaluate(({ nodeId, name }) => {
  window.__sedonStore__.getState().setInputValue(nodeId, name, undefined);
}, { nodeId: target.nodeId, name: inputName });
await new Promise((r) => setTimeout(r, 400));
const initial = await inspectDot();
console.log('dot at baseline (post-reset):', initial);

// Now apply an override via the store action — same path the inline
// editor's onChange takes — and expect the dot to flip to --set.
await page.evaluate(({ nodeId, name }) => {
  window.__sedonStore__.getState().setInputValue(nodeId, name, 999);
}, { nodeId: target.nodeId, name: inputName });
await new Promise((r) => setTimeout(r, 400));
const afterSet = await inspectDot();
console.log('dot after override:', afterSet);

// Click the now-visible dot. It must reset the value back to default.
// Fit to just the wrapper so the dot renders at its native 8px CSS
// (otherwise ReactFlow's default zoom shrinks it to ~3-4 screen px,
// where the click can land on a sibling element behind it instead).
// Select the wrapper first so F frames it (not the whole graph).
await page.evaluate((nodeId) => {
  // Click on the node header (the topmost area) to select. Done via
  // a synthesized event so we don't compete with our own dot logic.
  const rf = document.querySelector('.react-flow__pane');
  const el = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (!el || !rf) return;
  const r = el.getBoundingClientRect();
  // Top-right of node, inside the header but past the title text.
  const x = r.x + r.width - 8;
  const y = r.y + 8;
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
}, target.nodeId);
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 800));

// Re-read the dot position post-zoom — it's where the click needs to land.
const zoomedDot = await inspectDot();
console.log('zoomed-in dot:', zoomedDot);
if (zoomedDot?.clickX && zoomedDot?.clickY) {
  await page.mouse.click(zoomedDot.clickX, zoomedDot.clickY);
  await new Promise((r) => setTimeout(r, 400));
}
const afterReset = await inspectDot();
const storeAfterReset = await page.evaluate(({ nodeId, name }) => {
  const node = window.__sedonStore__.getState().graph.nodes.find((n) => n.id === nodeId);
  return {
    inputValuesHasKey: !!node?.inputValues && (name in node.inputValues),
    inputValue: node?.inputValues?.[name] ?? null,
  };
}, { nodeId: target.nodeId, name: inputName });
console.log('dot after reset:', afterReset);
console.log('store after reset:', storeAfterReset);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
// rgb(92, 200, 200) is the teal we picked.
const tealRe = /rgb\(92,\s*200,\s*200\)/;
const regularHasNoDots = regularNodeDots === 0;
const initialHidden = initial?.present === true && initial?.setClass === false;
const setVisible = afterSet?.setClass === true && tealRe.test(afterSet?.bg ?? '');
const resetHidden = afterReset?.setClass === false;
const storeCleared = storeAfterReset.inputValuesHasKey === false;
console.log(`regular node has ZERO override dots:    ${regularHasNoDots ? 'PASS ✓' : 'FAIL ✗'} (count=${regularNodeDots})`);
console.log(`baseline (post-reset): dot NOT --set:   ${initialHidden ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`override → dot becomes --set + teal:    ${setVisible ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`click dot → dot reverts:                ${resetHidden ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`click dot → key removed from store:     ${storeCleared ? 'PASS ✓' : 'FAIL ✗'}`);
const ok = regularHasNoDots && initialHidden && setVisible && resetHidden && storeCleared;
process.exit(ok ? 0 : 1);
