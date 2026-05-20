// Puppeteer driver for the "octaves change allocates buffers" repro.
//
// Steps mirrored from the user's manual repro:
//   1. Load Tree & Bush demo
//   2. Set __DEBUG_SCENE_PREVIEW__ = true
//   3. setActiveEditing('bark-texture')  (= double-clicking the Bark Texture asset)
//   4. dispatch setInputValue on the bark-texture's perlin node, octaves=3
//
// Drives the store directly via the debug hook in main.tsx — no UI clicks.
// Captures console output and prints it.

import puppeteer from 'puppeteer';

const URL = 'http://localhost:8080/?debug=1';

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox',
  ],
});

const page = await browser.newPage();

const logs = [];
page.on('console', async (msg) => {
  // msg.text() stringifies objects as "[object Object]". Expand args
  // explicitly via JSON so structured data (texture ids, scene shape)
  // makes it into the captured log.
  const parts = await Promise.all(
    msg.args().map(async (arg) => {
      try {
        return await arg.evaluate((v) => {
          if (typeof v === 'string') return v;
          if (v === null || v === undefined) return String(v);
          try { return JSON.stringify(v); } catch { return String(v); }
        });
      } catch {
        return String(arg);
      }
    }),
  );
  logs.push(parts.join(' '));
});
page.on('pageerror', (err) => {
  logs.push(`[PAGE ERROR] ${err.message}`);
});

await page.goto(URL, { waitUntil: 'networkidle2' });

// Wait for the debug hook to be installed and the store ready.
await page.waitForFunction(
  () => typeof window.__sedonStore__ === 'function' && typeof window.__sedonDemos__ !== 'undefined',
  { timeout: 10000 },
);

// === Enable debug logging BEFORE the demo loads so we capture
//     the initial-paint allocations too ===
await page.evaluate(() => {
  globalThis.__DEBUG_SCENE_PREVIEW__ = true;
  console.log('=== DEBUG FLAG ON ===');
});

// === Load Tree & Bush demo ===
await page.evaluate(() => {
  console.log('=== about to load tree-bush demo ===');
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  if (!demo) throw new Error('tree-bush demo not found');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});

// Let the initial eval round + paint settle. Multiple rAFs because
// async eval + cache sweep + render bus flushUnusedPools each schedule
// one frame later.
await new Promise((r) => setTimeout(r, 3000));

// === setActiveEditing('bark-texture') — equivalent to double-clicking the asset ===
await page.evaluate(() => {
  console.log('=== about to setActiveEditing bark-texture ===');
  window.__sedonStore__.getState().setActiveEditing('bark-texture');
});

// Let the navigation settle: React unmounts old node-canvas thumbnails,
// new node-canvas mounts, async eval starts + completes, sweepCache runs.
await new Promise((r) => setTimeout(r, 3000));

// === Find the perlin node inside bark-texture and bump octaves ===
const result = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const bark = state.subgraphs.find((s) => s.id === 'bark-texture');
  if (!bark) throw new Error('bark-texture subgraph missing');
  // The bark-texture subgraph has two perlins (fibers + detail). The
  // user's repro changes octaves on the FIRST one (fibers), which
  // matches scale [2,14]. Find it explicitly.
  const fibers = bark.graph.nodes.find(
    (n) => n.kind === 'core/perlin' && Array.isArray(n.inputValues?.scale) && n.inputValues.scale[1] === 14,
  );
  if (!fibers) throw new Error('fibers perlin not found in bark-texture');
  console.log('=== about to setInputValue octaves=3 on', fibers.id, '===');
  // Ensure we're in the bark-texture editing context (active graph =
  // bark-texture's inner graph) so dispatch routes the edit there.
  // setActiveEditing was called earlier, so this should already be true.
  state.setInputValue(fibers.id, 'octaves', 3);
  return { perlinId: fibers.id, currentEditingId: window.__sedonStore__.getState().currentEditingId };
});

console.log('repro driver: dispatched octaves=3 on', result.perlinId, 'in', result.currentEditingId);

// Let setScene fires + pool flushes settle.
await new Promise((r) => setTimeout(r, 2000));

// === SECOND octave change (octaves=4) to see steady-state cost ===
// If the initial round still has churn from initial-paint races, this
// second round should be the clean baseline — by now every consumer
// should have stable previousOutput pointers and the diff should be
// zero allocations.
await page.evaluate(() => {
  console.log('=== SECOND octave change (octaves=4) ===');
  window.__sedonStore__.getState().setInputValue(
    window.__sedonStore__.getState().graph.nodes.find((n) =>
      n.kind === 'core/perlin' && Array.isArray(n.inputValues?.scale) && n.inputValues.scale[1] === 14
    ).id,
    'octaves',
    4,
  );
});

await new Promise((r) => setTimeout(r, 2000));

console.log('\n========== CAPTURED CONSOLE LOG ==========\n');
for (const line of logs) console.log(line);

await browser.close();
