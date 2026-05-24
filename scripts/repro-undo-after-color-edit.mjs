// Regression: editing a colour picker (an `<input type="color">`)
// leaves focus on it; pressing Cmd/Ctrl+Z was being eaten by the
// node-canvas's "ignore undo while in an input" guard. Fix targets
// only TEXT-typed inputs (text/textarea/contenteditable). Verify by
// driving a setSubgraphInputDefault edit and then a Cmd+Z while a
// colour input is the focused element — the change must roll back.

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

// Pick the first Color subgraph input we can find, drill into its
// subgraph so the input-boundary is on screen.
const target = await page.evaluate(() => {
  const subgraphs = window.__sedonStore__.getState().subgraphs;
  for (const sg of subgraphs) {
    const inp = sg.inputs.find((i) => i.type === 'Color');
    if (inp) return { sgId: sg.id, inputName: inp.name, oldDefault: inp.default };
  }
  return null;
});
if (!target) { console.log('FAIL: no Color subgraph input'); process.exit(1); }
console.log('targeting:', target);

await page.evaluate((sgId) => {
  window.__sedonStore__.getState().setActiveEditing(sgId);
}, target.sgId);
await new Promise((r) => setTimeout(r, 1500));

// Apply a default change through the store (same path the UI's
// inline ColorInput.onChange calls), then move keyboard focus onto
// the matching colour-input element in the DOM. This reproduces the
// exact state the user is in right after picking a colour: the
// `<input type="color">` is the document.activeElement.
const newColor = [1, 0.5, 0.1, 1];
await page.evaluate(({ sgId, name, v }) => {
  window.__sedonStore__.getState().setSubgraphInputDefault(sgId, name, v);
}, { sgId: target.sgId, name: target.inputName, v: newColor });
await new Promise((r) => setTimeout(r, 300));

// Move focus onto the boundary's color input — the one this edit
// would naturally come from.
const focused = await page.evaluate(() => {
  const inp = document.querySelector('.react-flow__node input.sedon-colorinput');
  if (!inp) return null;
  inp.focus();
  return { tag: document.activeElement?.tagName, type: document.activeElement?.type };
});
console.log('after focus-on-color-input, activeElement:', focused);

const beforeUndo = await page.evaluate(({ sgId, name }) => {
  const sg = window.__sedonStore__.getState().subgraphs.find((s) => s.id === sgId);
  return sg?.inputs.find((i) => i.name === name)?.default ?? null;
}, { sgId: target.sgId, name: target.inputName });
console.log('default before undo:', beforeUndo);

// THE TEST: Cmd+Z while focus is on the colour input. With the OLD
// guard this was eaten; with the fix it lets through.
await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
// Also try Ctrl+Z in case macOS/headless reports it that way.
await page.keyboard.down('Control');
await page.keyboard.press('z');
await page.keyboard.up('Control');
await new Promise((r) => setTimeout(r, 400));

const afterUndo = await page.evaluate(({ sgId, name }) => {
  const sg = window.__sedonStore__.getState().subgraphs.find((s) => s.id === sgId);
  return sg?.inputs.find((i) => i.name === name)?.default ?? null;
}, { sgId: target.sgId, name: target.inputName });
console.log('default after  undo:', afterUndo);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const focusWasOnColorInput = focused?.tag === 'INPUT' && focused?.type === 'color';
const undidEdit = JSON.stringify(afterUndo) === JSON.stringify(target.oldDefault);
console.log(`focus landed on <input type="color">:  ${focusWasOnColorInput ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Cmd/Ctrl+Z reverted the default edit:  ${undidEdit ? 'PASS ✓' : 'FAIL ✗'}`);
process.exit(focusWasOnColorInput && undidEdit ? 0 : 1);
