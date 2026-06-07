// Reproduce the user's bug: clone a subgraph in the asset view,
// modify an inputValue on a node INSIDE the clone, observe whether
// the original subgraph is also mutated.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

try {
  await page.goto(`${server.url}?debug=1&scene=furniture`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));

  // 1) Pick the original wood-texture subgraph and grab a snapshot
  //    of its inner nodes' inputValues we can compare against later.
  const before = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const wood = state.subgraphs.find((s) => s.id === 'wood-texture');
    if (!wood) return { error: 'no wood-texture' };
    // Find palette / colorize / perlin nodes with relevant inputValues.
    return {
      id: wood.id,
      label: wood.label,
      nodes: wood.graph.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        inputValues: n.inputValues ?? null,
      })),
    };
  });
  console.log('Original wood-texture snapshot:');
  for (const n of before.nodes) {
    if (n.inputValues) console.log(' ', n.kind, JSON.stringify(n.inputValues).slice(0, 80));
  }

  // 2) Clone via pasteCopyAssets (same path Cmd-V uses).
  const cloneResult = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    return state.pasteCopyAssets({ subgraphIds: ['wood-texture'], folderIds: [] }, null);
  });
  console.log('Clone created:', JSON.stringify(cloneResult));
  const cloneId = cloneResult.subgraphIds[0];

  // 3) On the CLONE, find a node with an inputValue to mutate. Pick
  //    a perlin or palette node; mutate one of its values to a sentinel.
  const cloneFirstChange = await page.evaluate((cid) => {
    const state = window.__sedonStore__.getState();
    const clone = state.subgraphs.find((s) => s.id === cid);
    if (!clone) return { error: 'no clone' };
    // Find a node with inputValues to mutate.
    const target = clone.graph.nodes.find(
      (n) => n.inputValues && Object.keys(n.inputValues).length > 0 && !n.kind.startsWith('subgraph-'),
    );
    if (!target) return { error: 'no mutable node in clone' };
    const key = Object.keys(target.inputValues)[0];
    return { nodeId: target.id, kind: target.kind, key, originalValue: target.inputValues[key] };
  }, cloneId);
  console.log('Selected target in clone:', JSON.stringify(cloneFirstChange));

  // 4) Switch active editing to the clone and setInputValue — same
  //    path the editor takes when the user opens the clone and
  //    edits a value.
  await page.evaluate((cid, nodeId, key) => {
    window.__sedonStore__.getState().setActiveEditing(cid);
    window.__sedonStore__.getState().setInputValue(nodeId, key, [99, 99, 99, 1], { coalesce: false });
  }, cloneId, cloneFirstChange.nodeId, cloneFirstChange.key);

  // 5) Compare: did the ORIGINAL change?
  const after = await page.evaluate((origId, targetId, key) => {
    const state = window.__sedonStore__.getState();
    const orig = state.subgraphs.find((s) => s.id === origId);
    const origNode = orig?.graph.nodes.find((n) => n.id === targetId);
    return {
      origValue: origNode?.inputValues?.[key],
    };
  }, before.id, cloneFirstChange.nodeId, cloneFirstChange.key);
  console.log('Original\'s value AFTER mutating clone:', JSON.stringify(after));
  console.log('Original unchanged?', JSON.stringify(after.origValue) === JSON.stringify(cloneFirstChange.originalValue));

  // 6) NOW also reproduce the user's actual flow: change a
  //    SUBGRAPH INPUT DEFAULT on the clone (color_dark / color_light),
  //    and check whether the original's input default also changed.
  console.log('\n--- Subgraph input default mutation test ---');
  const inputsBefore = await page.evaluate((origId, cloneId2) => {
    const state = window.__sedonStore__.getState();
    const orig = state.subgraphs.find((s) => s.id === origId);
    const clone = state.subgraphs.find((s) => s.id === cloneId2);
    return {
      origColorDark: orig?.inputs.find((i) => i.name === 'color_dark')?.default,
      cloneColorDark: clone?.inputs.find((i) => i.name === 'color_dark')?.default,
      origInputsSameArrayAsClone: orig?.inputs === clone?.inputs,
      origColorDarkSameRefAsCloneColorDark:
        orig?.inputs.find((i) => i.name === 'color_dark') === clone?.inputs.find((i) => i.name === 'color_dark'),
    };
  }, before.id, cloneId);
  console.log('BEFORE:', JSON.stringify(inputsBefore));

  await page.evaluate((cid) => {
    window.__sedonStore__.getState().setSubgraphInputDefault(cid, 'color_dark', [1, 0, 0, 1]);
  }, cloneId);

  const inputsAfter = await page.evaluate((origId, cloneId2) => {
    const state = window.__sedonStore__.getState();
    const orig = state.subgraphs.find((s) => s.id === origId);
    const clone = state.subgraphs.find((s) => s.id === cloneId2);
    return {
      origColorDark: orig?.inputs.find((i) => i.name === 'color_dark')?.default,
      cloneColorDark: clone?.inputs.find((i) => i.name === 'color_dark')?.default,
    };
  }, before.id, cloneId);
  console.log('AFTER mutating clone:', JSON.stringify(inputsAfter));
  console.log('Did original change?',
    JSON.stringify(inputsBefore.origColorDark) !== JSON.stringify(inputsAfter.origColorDark)
      ? '*** YES — BUG ***' : 'no');

  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(' ', e);
  }
} finally {
  await browser.close();
  await server.stop();
}
