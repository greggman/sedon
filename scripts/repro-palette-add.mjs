// "Add: X" entries in the Cmd-Shift-P palette. Verifies:
//   1. After loading a graph, the palette contains an entry per
//      registered NodeDef (e.g. "Add: core/sphere", "Add: leaf/skeleton"),
//      plus the existing static commands.
//   2. Subgraph-internal kinds (subgraph-input/*, subgraph-output/*)
//      do NOT appear — they only make sense INSIDE a subgraph.
//   3. Subgraph wrappers DO appear ("Add: subgraph/<id>") so users can
//      drop a wrapper instance from the palette.
//   4. Filtering by "add core/sphere" lands on the sphere command;
//      pressing Enter inserts a core/sphere node into the active canvas.

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

// Load forest so we have a registry with subgraph wrappers.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 1200));

// Click the canvas first so DockView treats it as the active panel.
const canvasBox = await page.evaluate(() => {
  const el = document.querySelector('.sedon-panel--canvas');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.click(canvasBox.x, canvasBox.y);
await new Promise((r) => setTimeout(r, 200));

// Open the palette (Cmd/Ctrl+Shift+P).
const isMac = process.platform === 'darwin';
await page.keyboard.down(isMac ? 'Meta' : 'Control');
await page.keyboard.down('Shift');
await page.keyboard.press('P');
await page.keyboard.up('Shift');
await page.keyboard.up(isMac ? 'Meta' : 'Control');
await new Promise((r) => setTimeout(r, 200));

// Read all command labels.
const allLabels = await page.evaluate(() => {
  return [...document.querySelectorAll('.sedon-palette-label')]
    .map((el) => el.textContent ?? '');
});
console.log(`palette has ${allLabels.length} commands total`);

const addLabels = allLabels.filter((l) => l.startsWith('Add: '));
console.log(`add-node labels: ${addLabels.length}`);
console.log('sample add labels:', addLabels.slice(0, 8));

const hasSphere = addLabels.includes('Add: core/sphere');
const hasWrapper = addLabels.some((l) => l.startsWith('Add: subgraph/'));
const noInternals = !addLabels.some((l) =>
  l.startsWith('Add: subgraph-input/') || l.startsWith('Add: subgraph-output/'),
);

// Filter to "add core/sphere" and Enter.
const beforeNodeCount = await page.evaluate(() => window.__sedonStore__.getState().graph.nodes.length);
const beforeSphereCount = await page.evaluate(() =>
  window.__sedonStore__.getState().graph.nodes.filter((n) => n.kind === 'core/sphere').length,
);

await page.keyboard.type('core/sphere');
await new Promise((r) => setTimeout(r, 150));
const filteredLabels = await page.evaluate(() => {
  return [...document.querySelectorAll('.sedon-palette-label')]
    .map((el) => el.textContent ?? '');
});
console.log('filtered to:', filteredLabels);

await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 400));

const afterNodeCount = await page.evaluate(() => window.__sedonStore__.getState().graph.nodes.length);
const afterSphereCount = await page.evaluate(() =>
  window.__sedonStore__.getState().graph.nodes.filter((n) => n.kind === 'core/sphere').length,
);
const paletteClosed = await page.evaluate(() => document.querySelector('.sedon-palette') === null);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const hasSomeAdds = addLabels.length >= 10;
const sphereInserted = afterSphereCount === beforeSphereCount + 1
  && afterNodeCount === beforeNodeCount + 1;

console.log(`palette has many Add: entries:           ${hasSomeAdds ? 'PASS ✓' : 'FAIL ✗'} (${addLabels.length})`);
console.log(`Add: core/sphere is present:             ${hasSphere ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Add: subgraph/<id> wrappers present:     ${hasWrapper ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`subgraph-input/output kinds excluded:    ${noInternals ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`Enter on filtered match inserts sphere:  ${sphereInserted ? 'PASS ✓' : 'FAIL ✗'} (before=${beforeSphereCount}, after=${afterSphereCount})`);
console.log(`palette closes after Enter:              ${paletteClosed ? 'PASS ✓' : 'FAIL ✗'}`);

const ok = hasSomeAdds && hasSphere && hasWrapper && noInternals && sphereInserted && paletteClosed;
process.exit(ok ? 0 : 1);
