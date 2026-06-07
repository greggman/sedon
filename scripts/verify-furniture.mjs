// Load the furniture demo, screenshot the main showroom + each
// piece subgraph for visual review.
import puppeteer from 'puppeteer';
import { startDevServer } from '/Users/gregg/src/sedon/scripts/lib/dev-server.mjs';
import fs from 'node:fs';

const OUT_DIR = '/tmp/furniture-verify';

const server = await startDevServer({ prod: false });
console.log(`[verify] dev server at ${server.url}`);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
  if (msg.type() === 'warn') errors.push(`[console.warn] ${msg.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const drillAndShoot = async (graphId, fname) => {
  // openGraphInCanvas / openGraphInPreview update the per-panel pin
  // — setActiveEditing alone leaves panes locked to whatever they
  // were pinned to on demo load.
  await page.evaluate((id) => {
    window.__sedonOpenGraphInCanvas__(id);
    window.__sedonOpenGraphInPreview__(id);
  }, graphId);
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${OUT_DIR}/${fname}`, fullPage: false });
  console.log(`  saved ${fname}`);
};

try {
  // ?scene=basic suppresses the post-mount default demo load so the
  // verify script's own setGraph isn't racing with the auto-load.
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(
    () => typeof window.__sedonStore__ === 'function' && Array.isArray(window.__sedonDemos__),
    { timeout: 15000 },
  );
  await new Promise((r) => setTimeout(r, 1500));

  // Sanity: list demos before loading.
  const demoIds = await page.evaluate(() => window.__sedonDemos__.map((d) => d.id));
  console.log('[verify] demos:', demoIds.join(', '));
  if (!demoIds.includes('furniture')) {
    throw new Error('furniture demo not registered');
  }

  // Load furniture demo by fetching its .sedon file — same path as
  // the menu action under the new fetched-demos pipeline. Fetch and
  // setGraph are split into separate evaluates so a slow fetch doesn't
  // outlive its execution context (puppeteer's "Promise was collected"
  // when an async evaluate awaits longer than the context survives).
  const fetched = await page.evaluate(async () => {
    const r = await fetch('dist/demos/furniture.sedon');
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    return { ok: true, text: await r.text() };
  });
  if (!fetched.ok) throw new Error(`fetch failed: ${fetched.error}`);
  const loadResult = await page.evaluate((text) => {
    try {
      const file = JSON.parse(text);
      const project = file.project;
      window.__sedonStore__
        .getState()
        .setGraph(project.graph, project.rootNodeId, project.subgraphs ?? [], project.cameras);
      return {
        ok: true,
        nodes: project.graph.nodes.length,
        subgraphs: (project.subgraphs ?? []).map((s) => ({ id: s.id, label: s.label, nodes: s.graph.nodes.length })),
      };
    } catch (e) {
      return { ok: false, error: String(e), stack: e.stack };
    }
  }, fetched.text);
  console.log('[verify] load result:', JSON.stringify(loadResult, null, 2));
  if (!loadResult.ok) throw new Error(`load failed: ${loadResult.error}`);

  // Allow eval to run.
  await new Promise((r) => setTimeout(r, 3500));

  // Snapshot of the main scene.
  await page.screenshot({ path: `${OUT_DIR}/00-main.png`, fullPage: false });
  console.log('  saved 00-main.png');

  // Drill into each subgraph in turn and screenshot the preview pane.
  const targets = [
    ['chair', '01-chair.png'],
    ['table', '02-table.png'],
    ['sofa', '03-sofa.png'],
    ['bookshelf', '04-bookshelf.png'],
    ['filing-cabinet', '05-filing-cabinet.png'],
    ['tapered-leg', '06-tapered-leg.png'],
    ['cushion', '07-cushion.png'],
    ['wood-panel', '08-wood-panel.png'],
    ['drawer', '09-drawer.png'],
    ['book', '10-book.png'],
    ['wood-texture', '11-wood-texture.png'],
    ['fabric-texture', '12-fabric-texture.png'],
    ['metal-texture', '13-metal-texture.png'],
  ];
  for (const [id, fname] of targets) {
    await drillAndShoot(id, fname);
  }

  // Print any errors that landed during the run.
  if (errors.length > 0) {
    console.log('\n[verify] errors during run:');
    for (const e of errors) console.log('  ', e);
  } else {
    console.log('\n[verify] no console errors');
  }
} catch (e) {
  console.error('[verify] FAIL:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
