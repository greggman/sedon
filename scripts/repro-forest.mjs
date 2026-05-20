// Load Forest demo, screenshot the preview pane to verify it renders.

import puppeteer from 'puppeteer';

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
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:8080/?debug=1', { waitUntil: 'networkidle2' });
await page.waitForFunction(
  () => typeof window.__sedonStore__ === 'function',
  { timeout: 10000 },
);

await page.evaluate(() => {
  globalThis.__DEBUG_SCENE_PREVIEW__ = true;
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  if (!demo) throw new Error('forest demo not registered');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});

// Wait for evaluation + render to settle.
await new Promise((r) => setTimeout(r, 5000));

// Re-run eval explicitly to capture the root output value via direct
// API call (separate from the React-driven path).
const evalProbe = await page.evaluate(async () => {
  const s = window.__sedonStore__.getState();
  const registry = (() => {
    // Walk through the same registry the Preview uses.
    const r = { register() {}, get() {}, has() {}, list() {} };
    return r;
  })();
  void registry;
  // Just read the in-cache root output for the main graph: find the
  // root node id, look up its fp in lastFingerprintByNodeId, read the
  // entry.
  const rootId = s.mainRootNodeId;
  const fp = s.evalCache.lastFingerprintByNodeId.get(rootId);
  const out = fp ? s.evalCache.entries.get(fp) : null;
  return {
    rootNodeId: rootId,
    rootFp: fp ?? null,
    outputKeys: out ? Object.keys(out) : null,
    sceneEntities: out && out.scene ? out.scene.entities?.length ?? 'no-entities-field' : 'no-scene',
    sceneType: out && out.scene ? typeof out.scene : 'no-scene',
  };
});
console.log('eval probe:', JSON.stringify(evalProbe, null, 2));

// Inspect store + layout state for diagnostic info.
const diag = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  const layout = window.useLayoutStore?.getState?.() ?? {};
  return {
    currentEditingId: s.currentEditingId,
    mainNodes: s.mainGraph.nodes.length,
    mainEdges: s.mainGraph.edges.length,
    subgraphIds: s.subgraphs.map((sg) => sg.id),
    cacheEntries: s.evalCache.entries.size,
    cacheRounds: s.evalCache.stats.rounds,
    cacheMisses: s.evalCache.stats.cacheMisses,
    cacheHits: s.evalCache.stats.cacheHits,
    evalDurationMs: +s.evalCache.stats.evalDurationMs.toFixed(1),
    pinnedGraphIds: layout.pinnedGraphIds ?? {},
    canvasGraphIds: layout.canvasGraphIds ?? {},
    previewCanvases: document.querySelectorAll('.sedon-preview-pane canvas').length,
    previewTiles: document.querySelectorAll('.sedon-preview-pane .sedon-preview-tile').length,
    sceneCanvases: document.querySelectorAll('canvas.sedon-scene-preview').length,
    textureCanvases: document.querySelectorAll('canvas.sedon-texture-preview').length,
    previewPaneHTML: (() => {
      const el = document.querySelector('.sedon-preview-pane');
      if (!el) return 'NO .sedon-preview-pane';
      return el.outerHTML.slice(0, 400);
    })(),
  };
});
console.log('diagnostic:', JSON.stringify(diag, null, 2));

await page.screenshot({ path: '/tmp/forest-state.png', fullPage: false });
console.log('screenshot: /tmp/forest-state.png');

await browser.close();

console.log('\n========== CONSOLE LOGS ==========');
for (const line of logs) console.log(line);
