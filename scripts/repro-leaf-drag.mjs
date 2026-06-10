// Measure where time goes during a drag on `oak-leaf.colorize.low`.
//
// Drives the user's exact 5fps repro headlessly: open Tree & Bush,
// drill into oak-leaf in a canvas, then fire setInputValue at drag-
// tick rate while sampling `cache.stats` (rounds, nodeEvals,
// cacheHits, cacheMisses, evalDurationMs). The deltas tell us how
// many nodes actually re-evaluate per tick and how much CPU the eval
// layer is using.

import puppeteer from 'puppeteer';

const TICKS = 30; // typical 0.5s of dragging at ~60Hz request rate

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
      try {
        return await arg.evaluate((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
      } catch {
        return String(arg);
      }
    }),
  );
  logs.push(`[${msg.type()}] ${parts.join(' ')}`);
});

await page.goto('http://localhost:8080/?debug=1', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () =>
    typeof window.__sedonStore__ === 'function' &&
    typeof window.__sedonOpenGraphInCanvas__ === 'function',
  { timeout: 10000 },
);

// Load Tree & Bush, wait for stabilisation.
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3500));

// Open oak-leaf in the canvas — this flips currentEditingId so
// setInputValue targets nodes inside the oak-leaf inner graph.
await page.evaluate(() => {
  window.__sedonOpenGraphInCanvas__('oak-leaf');
});
await new Promise((r) => setTimeout(r, 1500));

// Find the colorize node and snapshot stats.
const colorizeId = await page.evaluate(() => {
  const sg = window.__sedonStore__.getState().subgraphs.find((s) => s.id === 'oak-leaf');
  if (!sg) throw new Error('oak-leaf subgraph not found');
  const c = sg.graph.nodes.find((n) => n.kind === 'tex/colorize');
  if (!c) throw new Error('colorize not found in oak-leaf');
  return c.id;
});

// Install a rAF counter so we can compute true visible frame rate
// during the drag. Visible frames = what the user actually perceives;
// eval rounds = backend work. They can diverge wildly.
await page.evaluate(() => {
  globalThis.__rafCount__ = 0;
  const tick = () => {
    globalThis.__rafCount__++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const snapshotStats = async () =>
  page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const stats = s.evalCache.stats;
    return {
      rounds: stats.rounds,
      nodeEvals: stats.nodeEvals,
      cacheHits: stats.cacheHits,
      cacheMisses: stats.cacheMisses,
      pendingHits: stats.pendingHits,
      evalDurationMs: stats.evalDurationMs,
      entries: s.evalCache.entries.size,
      rafCount: globalThis.__rafCount__,
    };
  });

const before = await snapshotStats();
const t0 = Date.now();
// Fire TICKS setInputValue calls, each slightly different so the
// dispatcher doesn't no-op on equal value. Awaits the microtask
// drain between ticks so React can schedule a render and effects can
// fire — that matches how a real drag interleaves with the React
// reconciler.
await page.evaluate(
  async (colorizeId, ticks) => {
    const setIV = window.__sedonStore__.getState().setInputValue;
    // Drive setInputValue back-to-back with zero artificial wait —
    // a real mouse-drag color picker fires many events per pointermove
    // and React/Zustand process them sequentially. Yielding to a
    // microtask (await 0) lets React batch but doesn't slow us.
    for (let i = 0; i < ticks; i++) {
      const t = i / Math.max(1, ticks - 1);
      setIV(colorizeId, 'low', [t, 0.36, 0.16, 1]);
      await new Promise((r) => setTimeout(r, 0));
    }
    // After the burst, let the last eval round finish.
    await new Promise((r) => setTimeout(r, 500));
  },
  colorizeId,
  TICKS,
);
const t1 = Date.now();
const after = await snapshotStats();

const delta = {
  rounds: after.rounds - before.rounds,
  nodeEvals: after.nodeEvals - before.nodeEvals,
  cacheHits: after.cacheHits - before.cacheHits,
  cacheMisses: after.cacheMisses - before.cacheMisses,
  pendingHits: after.pendingHits - before.pendingHits,
  evalDurationMs: +(after.evalDurationMs - before.evalDurationMs).toFixed(1),
  wallMs: t1 - t0,
};

const rafDelta = after.rafCount - before.rafCount;
console.log('========== DRAG TIMING ==========');
console.log(`ticks fired:            ${TICKS}`);
console.log(`wall time:              ${delta.wallMs}ms (${(TICKS / delta.wallMs * 1000).toFixed(1)} ticks/sec)`);
console.log(`visible rAF frames:     ${rafDelta}  (${(rafDelta / delta.wallMs * 1000).toFixed(1)} fps)`);
console.log(`eval rounds:            ${delta.rounds}  (${(delta.rounds / TICKS).toFixed(2)} per tick)`);
console.log(`node evals:             ${delta.nodeEvals}  (${(delta.nodeEvals / Math.max(1, delta.rounds)).toFixed(1)} per round)`);
console.log(`  cache hits:           ${delta.cacheHits}`);
console.log(`  pending hits:         ${delta.pendingHits}`);
console.log(`  cache misses (work):  ${delta.cacheMisses}`);
console.log(`total eval time:        ${delta.evalDurationMs}ms (${(delta.evalDurationMs / delta.wallMs * 100).toFixed(0)}% of wall)`);
console.log(`avg per round:          ${(delta.evalDurationMs / Math.max(1, delta.rounds)).toFixed(2)}ms`);
console.log(`entries in cache after: ${after.entries}`);

await browser.close();

if (process.argv.includes('--verbose')) {
  console.log('\n========== CONSOLE LOGS ==========\n');
  for (const line of logs) console.log(line);
}
