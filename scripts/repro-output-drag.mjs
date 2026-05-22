// Measure where time goes when dragging core/output.ambient on the
// Forest demo. The user's report: camera drag is 60fps, but editing
// the ambient colour runs ~10fps even though only a lighting uniform
// changes. This isolates eval cost (cache rounds/misses/duration) from
// render/React cost (rAF fps) so we know which layer to fix.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const TICKS = 30;
const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const evalLogs = [];
page.on('console', async (msg) => {
  try {
    const txt = await Promise.all(msg.args().map((a) => a.evaluate((v) => (typeof v === 'string' ? v : JSON.stringify(v)))));
    const s = txt.join(' ');
    if (s.includes('[evalGraph]')) evalLogs.push(s);
  } catch { /* */ }
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 5000));

// rAF counter for true frame rate.
await page.evaluate(() => {
  globalThis.__raf = 0;
  const t = () => { globalThis.__raf++; requestAnimationFrame(t); };
  requestAnimationFrame(t);
});

const outputId = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  const o = s.mainGraph.nodes.find((n) => n.kind === 'core/output');
  if (!o) throw new Error('no core/output');
  return o.id;
});

const snap = () => page.evaluate(() => {
  const s = window.__sedonStore__.getState().evalCache.stats;
  return { rounds: s.rounds, nodeEvals: s.nodeEvals, hits: s.cacheHits, misses: s.cacheMisses, ms: s.evalDurationMs, sweepMs: s.sweepMs, sweeps: s.sweeps, raf: globalThis.__raf, cnRenders: globalThis.__cnRenders ?? 0 };
});

// Enable debug logging just for the drag window (skip load noise).
await page.evaluate(() => { globalThis.__DEBUG_SCENE_PREVIEW__ = true; });
const before = await snap();
const t0 = Date.now();
await page.evaluate(async (outputId, ticks) => {
  const setIV = window.__sedonStore__.getState().setInputValue;
  for (let i = 0; i < ticks; i++) {
    const a = 0.1 + 0.3 * (i / ticks);
    setIV(outputId, 'ambient', [a, a, a, 1]);
    await new Promise((r) => setTimeout(r, 16));
  }
  await new Promise((r) => setTimeout(r, 300));
}, outputId, TICKS);
const wall = Date.now() - t0;
const after = await snap();

await browser.close();
await server.stop();

const d = {
  rounds: after.rounds - before.rounds,
  nodeEvals: after.nodeEvals - before.nodeEvals,
  hits: after.hits - before.hits,
  misses: after.misses - before.misses,
  ms: +(after.ms - before.ms).toFixed(1),
  sweepMs: +(after.sweepMs - before.sweepMs).toFixed(1),
  sweeps: after.sweeps - before.sweeps,
  raf: after.raf - before.raf,
  cnRenders: after.cnRenders - before.cnRenders,
};
console.log('\n===== output.ambient drag (forest) =====');
console.log(`ticks:            ${TICKS}`);
console.log(`wall:             ${wall}ms`);
console.log(`visible fps:      ${(d.raf / wall * 1000).toFixed(1)}`);
console.log(`eval rounds:      ${d.rounds}  (${(d.rounds / TICKS).toFixed(1)}/tick)`);
console.log(`node evals:       ${d.nodeEvals}`);
console.log(`  cache hits:     ${d.hits}`);
console.log(`  cache misses:   ${d.misses}  (${(d.misses / TICKS).toFixed(1)}/tick — should be ~1: just the output node)`);
console.log(`total eval time:  ${d.ms}ms  (${(d.ms / wall * 100).toFixed(0)}% of wall)`);
console.log(`sweepCache:       ${d.sweepMs}ms over ${d.sweeps} sweeps  (${(d.sweepMs / wall * 100).toFixed(0)}% of wall)`);
console.log(`CustomNode renders: ${d.cnRenders}  (${(d.cnRenders / TICKS).toFixed(1)}/tick — ideally ~1: just the edited node)`);
console.log('\n=== sample [evalGraph] breakdowns (last 6) ===');
for (const l of evalLogs.slice(-6)) console.log(l);
