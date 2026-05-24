// Editable subgraph-input defaults (item #5). Verifies:
//   1. The input-boundary row inside a subgraph renders an inline
//      editor for the captured default (a number input for Float, a
//      color picker for Color, etc.).
//   2. Editing that default propagates: every wrapper instance using
//      the subgraph that doesn't wire the input gets the new default
//      on its next eval (cache invalidates correctly).
//
// We drive this against the forest demo's `branch-bush` subgraph,
// which has a wrapper in main.

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

// Pick a subgraph that HAS at least one declared input with a default,
// and drill into it via setActiveEditing — way more reliable than
// scripting an "Edit" button click. Search the project for one.
const target = await page.evaluate(() => {
  const subgraphs = window.__sedonStore__.getState().subgraphs;
  for (const sg of subgraphs) {
    const inp = sg.inputs.find((i) =>
      // Float / Color / Int are the editable scalar types the inline
      // editor switch can render.
      i.type === 'Float' || i.type === 'Color' || i.type === 'Int' || i.type === 'Vec3',
    );
    if (inp) return { sgId: sg.id, sgLabel: sg.label, inputName: inp.name, inputType: inp.type, oldDefault: inp.default };
  }
  return null;
});
if (!target) { console.log('FAIL: no subgraph with editable input found'); process.exit(1); }
console.log('targeting subgraph input:', target);

// Drill into the subgraph (canvas view + active editing context).
await page.evaluate((sgId) => {
  window.__sedonStore__.getState().setActiveEditing(sgId);
}, target.sgId);
await new Promise((r) => setTimeout(r, 1500));

// Confirm the input-boundary node is on screen and one of its OUTPUT
// rows has an inline editor (the new `.sedon-node-editor` span that
// our code injects for boundary outputs).
const boundaryInfo = await page.evaluate((inputName) => {
  const nodes = [...document.querySelectorAll('.react-flow__node')];
  const boundary = nodes.find((el) => {
    const id = el.getAttribute('data-id');
    if (!id) return false;
    const node = window.__sedonStore__.getState().graph.nodes.find((n) => n.id === id);
    return node?.kind?.startsWith('subgraph-input/');
  });
  if (!boundary) return null;
  // Find the row that corresponds to OUR input. Row text contains the
  // socket label; we look up by name → label from the store.
  const sg = window.__sedonStore__.getState().subgraphs.find((g) => g.inputs.some((i) => i.name === inputName));
  const inp = sg?.inputs.find((i) => i.name === inputName);
  const label = inp?.label ?? inp?.name;
  const rows = [...boundary.querySelectorAll('.sedon-node-row')];
  const row = rows.find((r) => r.textContent?.includes(label ?? ''));
  return {
    found: !!boundary,
    rowsWithEditor: rows.filter((r) => r.querySelector('.sedon-node-editor')).length,
    thisRowHasEditor: !!row?.querySelector('.sedon-node-editor'),
  };
}, target.inputName);
console.log('boundary inspection:', boundaryInfo);

// Pixel hash of one downstream canvas tile BEFORE the default change.
// If the canvas re-evaluates (the fix), this hash should differ AFTER.
// If the canvas does NOT re-evaluate (the bug), they'd match.
async function hashCanvasPreviews() {
  const buf = await page.screenshot({ type: 'png' });
  // Cheap hash: sum of every 100th byte. Tiny canvas-preview tiles
  // change a lot of pixels at once when their input shifts, so any
  // global eval re-run is easy to detect even with a coarse hash.
  let h = 0;
  for (let i = 0; i < buf.length; i += 100) h = (h * 31 + buf[i]) | 0;
  return h;
}
const previewsBefore = await hashCanvasPreviews();

// Drive a default change via the store (UI-driving for number inputs
// is timing-fragile because of the drag-scrub interaction). The
// component's onChange routes to this same action — verified
// separately in unit tests.
const newValue = target.inputType === 'Float'
  ? Number(target.oldDefault ?? 0) + 0.25
  : target.inputType === 'Int'
    ? Number(target.oldDefault ?? 0) + 3
    : target.inputType === 'Color'
      ? [1, 0, 0, 1]
      : [9, 9, 9]; // Vec3
await page.evaluate(({ sgId, name, v }) => {
  window.__sedonStore__.getState().setSubgraphInputDefault(sgId, name, v);
}, { sgId: target.sgId, name: target.inputName, v: newValue });
// Give the eval effect (re-running because subgraphInputsKey changed)
// a moment to complete + the in-node preview tiles to repaint.
await new Promise((r) => setTimeout(r, 1500));
const previewsAfter = await hashCanvasPreviews();
console.log('preview pixel hash before:', previewsBefore, ' after:', previewsAfter);

const afterEdit = await page.evaluate(({ sgId, name }) => {
  const sg = window.__sedonStore__.getState().subgraphs.find((s) => s.id === sgId);
  return sg?.inputs.find((i) => i.name === name)?.default ?? null;
}, { sgId: target.sgId, name: target.inputName });
console.log('updated default in store:', afterEdit);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const boundaryFound = boundaryInfo?.found === true;
const rowHasEditor = boundaryInfo?.thisRowHasEditor === true;
const storeUpdated = JSON.stringify(afterEdit) === JSON.stringify(newValue);
const evalReran = previewsBefore !== previewsAfter;
console.log(`input-boundary visible in subgraph:    ${boundaryFound ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`boundary row has inline editor:        ${rowHasEditor ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`setSubgraphInputDefault updates store: ${storeUpdated ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`in-node previews re-rendered (isolated eval picked up new default): ${evalReran ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(boundaryFound && rowHasEditor && storeUpdated && evalReran ? 0 : 1);
