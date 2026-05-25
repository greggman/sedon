// Connection-dot vs row-label alignment.
// Verifies that for every row on every node, the input/output handle is
// vertically centered on the row text — i.e. the dot lines up with the
// label, no "dot floats above text" misalignment from forgotten border
// pixels. Tolerance accounts for sub-pixel rounding at non-1.0 zooms.

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

// Forest covers nodes with AND without preview slots (the 3px-vs-2px
// border-accounting case) plus subgraph wrappers, so every row variant
// gets measured.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 1500));

// Frame everything so all nodes are on-screen + at a consistent zoom.
await page.keyboard.press('f');
await new Promise((r) => setTimeout(r, 800));

const measurements = await page.evaluate(() => {
  const out = [];
  const nodes = [...document.querySelectorAll('.react-flow__node')];
  for (const n of nodes) {
    const id = n.getAttribute('data-id');
    const rows = [...n.querySelectorAll('.sedon-node-row')];
    const handles = [...n.querySelectorAll('.react-flow__handle')];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const label = row.querySelector('.sedon-node-label');
      if (!label) continue;
      const rR = row.getBoundingClientRect();
      const rowCY = rR.top + rR.height / 2;
      // Find the handle whose y center is closest to this row's center.
      let bestDelta = Infinity;
      for (const h of handles) {
        const hR = h.getBoundingClientRect();
        const hCY = hR.top + hR.height / 2;
        const d = Math.abs(hCY - rowCY);
        if (d < bestDelta) bestDelta = d;
      }
      out.push({
        nodeId: id,
        rowIndex: i,
        label: label.textContent?.trim(),
        deltaPx: Math.round(bestDelta * 100) / 100,
      });
    }
  }
  return out;
});

// At zoom 1 a 1px misalignment is the floor of perception; we frame-fit
// (which usually lands around zoom 0.4–0.6), so the per-pixel tolerance
// scales with zoom. Pick a forgiving 0.6 visible-pixel threshold —
// anything more than that is the bug.
const THRESHOLD = 0.6;
const offenders = measurements.filter((m) => m.deltaPx > THRESHOLD);
const max = measurements.reduce((acc, m) => Math.max(acc, m.deltaPx), 0);

console.log(`measured ${measurements.length} rows across all nodes`);
console.log(`max delta: ${max} px`);
if (offenders.length > 0) {
  console.log(`offenders (delta > ${THRESHOLD} px):`);
  for (const o of offenders.slice(0, 10)) {
    console.log(`  node=${o.nodeId} row=${o.rowIndex} label="${o.label}" delta=${o.deltaPx}px`);
  }
  if (offenders.length > 10) console.log(`  ... and ${offenders.length - 10} more`);
}

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
console.log(`every handle within ${THRESHOLD}px of its row center: ${offenders.length === 0 ? 'PASS ✓' : 'FAIL ✗'} (${offenders.length} offenders, max=${max}px)`);
process.exit(offenders.length === 0 ? 0 : 1);
