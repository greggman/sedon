// Reproduce user-reported bug: with the tree-bush scene editing the
// Branch Canopy subgraph and previewing it, toggling the `align`
// boolean on `geom/instance-on-points` off then on again
// leaves the leaves stuck in the un-aligned configuration even
// though the input value matches the original.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[page error]', msg.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 3000));

// Find the Branch Canopy subgraph + the instance-geometry-on-points node inside it.
const setup = await page.evaluate(() => {
  const state = window.__sedonStore__.getState();
  const subgraphs = state.subgraphs;
  // Match by name (case-insensitive) since ids may be machine-generated.
  const canopy = subgraphs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
  if (!canopy) return { error: 'no canopy subgraph', names: subgraphs.map((s) => s.name) };
  const igon = canopy.graph.nodes.find((n) => n.kind === 'geom/instance-on-points');
  return {
    canopyId: canopy.id,
    canopyName: canopy.name,
    igonId: igon?.id,
    initialAlign: igon?.inputValues?.align,
  };
});
console.log('setup:', setup);
if (setup.error) { await browser.close(); await server.stop(); process.exit(1); }

// Drive the editor's "edit this subgraph" + "preview this subgraph" flow.
await page.evaluate((canopyId) => {
  const st = window.__sedonStore__.getState();
  // Both panels target Branch Canopy: main canvas edits it, the
  // preview panel renders its root output.
  if (window.__sedonOpenGraphInCanvas__) window.__sedonOpenGraphInCanvas__(canopyId, 'canvas-main');
  if (window.__sedonOpenGraphInPreview__) window.__sedonOpenGraphInPreview__(canopyId, 'preview-main');
  void st;
}, setup.canopyId);
await new Promise((r) => setTimeout(r, 1500));

async function getMeshSignature(igonId, panelId = 'canvas-main') {
  return page.evaluate(({ id, panel }) => {
    const out = window.__sedonGetOutputs__(panel, id);
    if (!out || !out.geometry) return { state: 'no-geometry' };
    const mesh = out.geometry.mesh;
    if (!mesh) return { state: 'no-mesh' };
    // Sample a few normals + positions so we can detect "aligned vs not."
    // For an aligned leaf instance, normals point outward (radial). For
    // un-aligned, normals stay in the source mesh's local frame (mostly +Y
    // or similar). Sum-of-absolute Y vs sum-of-absolute X+Z gives a
    // crude axis-orientation signature.
    let ny = 0, nxz = 0, count = 0;
    const N = mesh.normals;
    const step = Math.max(1, Math.floor(N.length / 3 / 200));
    for (let i = 0; i < N.length; i += 3 * step) {
      ny += Math.abs(N[i + 1]);
      nxz += Math.abs(N[i]) + Math.abs(N[i + 2]);
      count++;
    }
    return {
      state: 'ok',
      vertCount: mesh.positions.length / 3,
      sampledNormals: count,
      meanAbsNy: (ny / count).toFixed(3),
      meanAbsNxz: (nxz / count).toFixed(3),
    };
  }, { id: igonId, panel: panelId });
}

async function setAlign(value, igonId) {
  await page.evaluate(({ id, v }) => {
    const st = window.__sedonStore__.getState();
    st.setInputValue(id, 'align', v);
  }, { id: igonId, v: value });
  await new Promise((r) => setTimeout(r, 1500));
}

async function shotPreview(tag) {
  // The Preview panel renders the canopy's scene output.
  const previewCanvas = await page.$('.sedon-preview-canvas, .preview-pane canvas, [data-panel-id*=preview] canvas');
  if (previewCanvas) {
    await previewCanvas.screenshot({ path: `/tmp/align-${tag}.png` });
    console.log(`  saved /tmp/align-${tag}.png`);
  } else {
    // Fall back to a full-page screenshot if we can't find the panel.
    await page.screenshot({ path: `/tmp/align-${tag}-full.png` });
    console.log(`  no preview canvas — saved full page /tmp/align-${tag}-full.png`);
  }
}

async function dumpPreviewPanelInfo() {
  return page.evaluate(() => {
    const ids = window.__sedonListPanelIds__();
    const out = {};
    for (const id of ids) {
      const opts = window.__sedonGetOutputs__(id, '__none__'); // probe presence
      out[id] = opts === undefined ? 'panel exists' : 'has output';
    }
    return { panelIds: ids, info: out };
  });
}

console.log('\npanels:', await dumpPreviewPanelInfo());

console.log('\n--- baseline (align as authored) ---');
console.log('canvas-main:', await getMeshSignature(setup.igonId, 'canvas-main'));
console.log('preview-main:', await getMeshSignature(setup.igonId, 'preview-main'));
await shotPreview('1-baseline');

console.log('\n--- align = false ---');
await setAlign(false, setup.igonId);
console.log('canvas-main:', await getMeshSignature(setup.igonId, 'canvas-main'));
console.log('preview-main:', await getMeshSignature(setup.igonId, 'preview-main'));
await shotPreview('2-off');

console.log('\n--- align = true (back) ---');
await setAlign(true, setup.igonId);
console.log('canvas-main:', await getMeshSignature(setup.igonId, 'canvas-main'));
console.log('preview-main:', await getMeshSignature(setup.igonId, 'preview-main'));
await shotPreview('3-on');

await new Promise((r) => setTimeout(r, 1000));
await browser.close();
await server.stop();
