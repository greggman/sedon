// Reproduce the EXACT user flow:
//  1. Open scene=furniture (where wood-texture exists and is wired
//     into furniture pieces).
//  2. Select the wood-texture tile in the asset view.
//  3. Cmd-C / Cmd-V to clone.
//  4. Open the clone in the canvas.
//  5. Edit color_dark to red on the clone's boundary input node.
//  6. Re-render; check whether the ORIGINAL wood-texture or any
//     piece referencing it has changed colour.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

try {
  await page.goto(`${server.url}?debug=1&scene=furniture`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4000));

  // 1) Snapshot original wood-texture's color_dark default.
  const beforeOrig = await page.evaluate(() => {
    const wood = window.__sedonStore__.getState().subgraphs.find((s) => s.id === 'wood-texture');
    return {
      id: wood?.id,
      colorDark: wood?.inputs.find((i) => i.name === 'color_dark')?.default,
      colorLight: wood?.inputs.find((i) => i.name === 'color_light')?.default,
    };
  });
  console.log('Original BEFORE clone:', JSON.stringify(beforeOrig));

  // 2) Clone the wood-texture via paste.
  const cloneId = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const r = state.pasteCopyAssets({ subgraphIds: ['wood-texture'], folderIds: [] }, null);
    return r.subgraphIds[0];
  });
  console.log('Clone id:', cloneId);

  // 3) IMMEDIATELY check identities and shared references.
  const sharedCheck = await page.evaluate((cid) => {
    const state = window.__sedonStore__.getState();
    const orig = state.subgraphs.find((s) => s.id === 'wood-texture');
    const clone = state.subgraphs.find((s) => s.id === cid);
    return {
      sameInputsArray: orig?.inputs === clone?.inputs,
      sameColorDarkObj: orig?.inputs.find((i) => i.name === 'color_dark') === clone?.inputs.find((i) => i.name === 'color_dark'),
      sameColorDarkValue: orig?.inputs.find((i) => i.name === 'color_dark')?.default === clone?.inputs.find((i) => i.name === 'color_dark')?.default,
      sameGraphObj: orig?.graph === clone?.graph,
      sameNodesArray: orig?.graph.nodes === clone?.graph.nodes,
    };
  }, cloneId);
  console.log('Reference sharing after clone:', JSON.stringify(sharedCheck, null, 2));

  // 4) Modify clone's color_dark input default to RED.
  await page.evaluate((cid) => {
    window.__sedonStore__.getState().setSubgraphInputDefault(cid, 'color_dark', [1, 0, 0, 1]);
  }, cloneId);

  // 5) Compare original and clone after modification.
  const after = await page.evaluate((cid) => {
    const state = window.__sedonStore__.getState();
    const orig = state.subgraphs.find((s) => s.id === 'wood-texture');
    const clone = state.subgraphs.find((s) => s.id === cid);
    return {
      origColorDark: orig?.inputs.find((i) => i.name === 'color_dark')?.default,
      cloneColorDark: clone?.inputs.find((i) => i.name === 'color_dark')?.default,
    };
  }, cloneId);
  console.log('AFTER mutating clone:', JSON.stringify(after));

  // 6) Also check whether the chair (which references wood-texture)
  //    has the original's color_dark or some other value.
  const chairWood = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const chair = state.subgraphs.find((s) => s.id === 'chair');
    // Find the subgraph/wood-texture wrapper inside chair.
    const wrapper = chair?.graph.nodes.find((n) => n.kind === 'subgraph/wood-texture');
    return {
      wrapperKind: wrapper?.kind,
      wrapperInputValues: wrapper?.inputValues ?? null,
    };
  });
  console.log('Chair wood-texture wrapper:', JSON.stringify(chairWood));

  // 7) Check the live REGISTRY view of subgraph/wood-texture (original).
  //    The wrapper's `inputs` field is what defineSubgraph uses for
  //    standalone defaults — if that array got contaminated with
  //    the clone's red colour, that's the bug.
  const registryView = await page.evaluate(() => {
    // The editor builds the registry via buildRegistry(subgraphs).
    // Re-derive it here using the same path the editor uses.
    return import('/dist/main.js').catch(() => null).then(() => {
      // We don't have direct access to buildRegistry; use the store's
      // subgraphs and inspect input arrays.
      const state = window.__sedonStore__.getState();
      const orig = state.subgraphs.find((s) => s.id === 'wood-texture');
      const cdEntry = orig?.inputs.find((i) => i.name === 'color_dark');
      return {
        origInputsLength: orig?.inputs.length,
        origColorDark: cdEntry?.default,
        origColorDarkType: Array.isArray(cdEntry?.default) ? 'array' : typeof cdEntry?.default,
      };
    });
  });
  console.log('Live original inputs view:', JSON.stringify(registryView));

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
} finally {
  await browser.close();
  await server.stop();
}
