// Furniture demo: visual verification of the showroom scene + each
// piece's drill-in standalone preview. Loads ?scene=furniture, takes
// a screenshot of the main scene, then walks each piece subgraph
// (chair, sofa, table, bookshelf, file-cabinet) by calling
// `setActiveEditing(id)` on the store and screenshotting each
// standalone preview tile.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
  protocolTimeout: 240_000,
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => { errs.push(`[pageerror] ${e.message}`); console.error('PAGEERROR:', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errs.push(`[err] ${msg.text()}`); console.error('CONSOLE-ERR:', msg.text()); }
});

await page.goto(`${server.url}?debug=1&scene=furniture`, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => typeof window.__sedonStore__ !== 'undefined', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 6000)); // let WebGPU warm up & framebuffers settle

// Diagnostics — camera, root, eval state.
const diag = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return {
    currentEditingId: s.currentEditingId,
    rootNodeId: s.rootNodeId,
    cameras: s.cameras,
    nodeCount: s.graph.nodes.length,
    rootKind: s.graph.nodes.find((n) => n.id === s.rootNodeId)?.kind,
  };
});
console.log('store diagnostics:', JSON.stringify({ ...diag, cameras: undefined }, null, 2));

// Pull eval outputs at root — non-empty means rendering should work.
const outputs = await page.evaluate(() => {
  const get = window.__sedonGetOutputs__;
  const list = window.__sedonListPanelIds__;
  if (!get || !list) return { error: 'no debug eval hook' };
  const panels = list();
  const s = window.__sedonStore__.getState();
  let out;
  for (const p of panels) {
    out = get(p, s.rootNodeId);
    if (out) return { panel: p, panelsAll: panels, keys: Object.keys(out),
      summary: Object.fromEntries(Object.entries(out).map(([k, v]) => [
        k,
        v == null ? 'null' :
        typeof v === 'object' ? (
          Array.isArray(v) ? `array[${v.length}]` :
          'kind' in v ? `${v.kind}` :
          Object.keys(v).join(',')
        ) : typeof v,
      ])),
    };
  }
  return { error: 'no outputs at root', panels, rootNodeId: s.rootNodeId };
});
console.log('root outputs:', JSON.stringify(outputs, null, 2));

// Snapshot the entire layout. Also dump the registered subgraph ids
// so we know which ones are pieces (chair, sofa, etc.) and which are
// shared components (leg, cushion, panel, drawer, book, textures).
const subgraphInfo = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return s.subgraphs.map((sg) => ({ id: sg.id, label: sg.label }));
});
console.log('subgraphs registered:');
for (const sg of subgraphInfo) console.log(`  - ${sg.id}  →  ${sg.label}`);

async function screenshotPreviewCanvas(path) {
  // Find the preview canvas — it lives inside the preview panel.
  // The node-canvas (React Flow) doesn't use a <canvas>; only the
  // WebGPU previews do. So in practice any visible canvas is a
  // preview, but be explicit by locating one inside an element
  // identifying as preview.
  const box = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('canvas'));
    const info = all.map((c) => {
      const r = c.getBoundingClientRect();
      let parent = c.parentElement;
      let host = null;
      while (parent) {
        if (parent.classList?.contains?.('sedon-preview-pane')
          || parent.classList?.contains?.('sedon-preview')
          || parent.getAttribute?.('data-preview') !== null) {
          host = parent.className || 'preview';
          break;
        }
        parent = parent.parentElement;
      }
      return { x: r.x, y: r.y, w: r.width, h: r.height, host, w0: c.width, h0: c.height };
    });
    return info;
  });
  console.log('  canvas inventory:', JSON.stringify(box, null, 2));
  // Pick the largest visible WebGPU canvas. They are inside the
  // preview panel and have non-zero internal dimensions.
  const visible = box.filter((b) => b.w > 0 && b.h > 0 && b.w0 > 0);
  visible.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const chosen = visible[0];
  if (!chosen) throw new Error('no preview canvas found');
  await page.screenshot({ path, clip: { x: chosen.x, y: chosen.y, width: chosen.w, height: chosen.h } });
}

await screenshotPreviewCanvas('/tmp/furniture-main.png');
console.log('→ /tmp/furniture-main.png');

// Standalone-preview each piece. setActiveEditing(id) bumps the
// editor into that subgraph; the preview rebuilds against the
// subgraph's standalone output (core/output if present, else
// boundary).
const pieces = ['chair', 'sofa', 'table', 'bookshelf', 'filing-cabinet'];
for (const id of pieces) {
  const exists = subgraphInfo.some((sg) => sg.id === id);
  if (!exists) {
    console.warn(`!! subgraph "${id}" NOT FOUND in registered subgraphs`);
    continue;
  }
  await page.evaluate((sgId) => {
    window.__sedonStore__.getState().setActiveEditing(sgId);
  }, id);
  await new Promise((r) => setTimeout(r, 3000)); // let eval + GPU paint settle
  await screenshotPreviewCanvas(`/tmp/furniture-${id}.png`);
  console.log(`→ /tmp/furniture-${id}.png`);
}

await browser.close();
await server.stop();

if (errs.length) {
  console.error('\nERRORS during run:');
  for (const e of errs) console.error('  ', e);
  process.exit(1);
}
console.log('OK');
