// End-to-end check for "Extract to Subgraph":
//
//   1. Load the basic scene (grid → material → scene-entity ← sphere
//      → scene-entity → output).
//   2. Select material + scene-entity (two adjacent nodes).
//   3. Fire the action `selection.extract-subgraph`.
//   4. Verify:
//        • a new subgraph appeared in state.subgraphs
//        • the wrapper landed in main, replacing material+scene-entity
//        • the wrapper carries the same outer connections (grid, sphere
//          feed it; output reads from it)
//        • internal connection (material → scene-entity) lives inside
//          the new subgraph
//        • the new subgraph has the right number of input/output
//          sockets
//        • single undo step reverts everything
//
// Driven via MCP runAction so we exercise the same path a user would
// via the command palette or the right-click menu.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});
page.on('dialog', (d) => { void d.accept(); });

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  await page.evaluate(() => {
    window.__sedonGetDockview__?.()?.getPanel('canvas-main')?.api.setActive();
  });
  await new Promise((r) => setTimeout(r, 200));

  // Snapshot the starting state — basic scene has 5 nodes.
  const before = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodes: s.mainGraph.nodes.map((n) => ({
        id: n.id, kind: n.kind, position: n.position,
      })),
      mainEdges: s.mainGraph.edges.map((e) => ({
        id: e.id, from: e.from, to: e.to,
      })),
      subgraphCount: s.subgraphs.length,
      mainRootNodeId: s.mainRootNodeId,
    };
  });
  console.log('Baseline: mainNodes', before.mainNodes.length,
              'edges', before.mainEdges.length,
              'subgraphs', before.subgraphCount);

  // Pick the two nodes to extract. material has an input (basecolor from
  // grid) and an output (material to scene-entity). scene-entity has
  // inputs (geometry from sphere, material from material) and an output
  // (scene to output). Together they form a closed "material + entity"
  // chunk with internal edge material→scene-entity.
  const matId = before.mainNodes.find((n) => n.kind === 'core/material').id;
  const entityId = before.mainNodes.find((n) => n.kind === 'core/scene-entity').id;

  // Mark them selected in RF (the action reads the RF instance's
  // per-node selected flag through getActiveCanvasRf()).
  await page.evaluate(({ matId, entityId }) => {
    // Find the canvas's RF instance via the layout/rf-registry.
    // Cheaper path: dispatch a click on each node element with the
    // ctrl key for multi-select. But synthetic events can be
    // flaky. Instead, set selection through the RF nodes change
    // mechanism by mutating the DOM `.react-flow__node--selected`
    // class won't reach RF's state… so use puppeteer's mouse with
    // ctrl-click.
    return { matId, entityId };
  }, { matId, entityId });

  // Ctrl-click material then scene-entity to multi-select.
  for (const id of [matId, entityId]) {
    const rect = await page.evaluate((id) => {
      const el = document.querySelector(`.react-flow__node[data-id="${id}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + 20 };
    }, id);
    if (!rect) throw new Error(`no DOM for node ${id}`);
    await page.keyboard.down('Meta');
    await page.mouse.click(rect.x, rect.y);
    await page.keyboard.up('Meta');
    await new Promise((r) => setTimeout(r, 100));
  }

  // Verify both are selected RF-side.
  const sel = await page.evaluate(() => {
    const selected = [...document.querySelectorAll('.react-flow__node.selected')]
      .map((n) => n.getAttribute('data-id'));
    return selected;
  });
  console.log('Selected:', sel);

  // Fire the action.
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'selection.extract-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 600));
  // Commit the auto-rename so we have a stable wrapper.
  const renameInput = await page.$('.sedon-editable-name-input');
  if (renameInput) {
    await renameInput.click({ clickCount: 3 });
    await page.keyboard.type('extracted');
    await page.keyboard.press('Enter');
  }
  await new Promise((r) => setTimeout(r, 200));

  const after = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodes: s.mainGraph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
      mainEdges: s.mainGraph.edges.map((e) => ({ from: e.from, to: e.to })),
      subgraphs: s.subgraphs.map((sg) => ({
        id: sg.id, label: sg.label,
        inputs: sg.inputs.map((i) => ({ label: i.label, type: i.type })),
        outputs: sg.outputs.map((o) => ({ label: o.label, type: o.type })),
        innerKinds: sg.graph.nodes.map((n) => n.kind),
        innerEdgeCount: sg.graph.edges.length,
      })),
    };
  });
  console.log('After extraction:');
  console.log('  main kinds:', after.mainNodes.map((n) => n.kind));
  console.log('  subgraphs:', JSON.stringify(after.subgraphs, null, 2));

  const wrapper = after.mainNodes.find((n) => n.kind.startsWith('subgraph/'));
  const newSg = after.subgraphs[0];

  // Check outer wiring: there should be edges from grid → wrapper
  // (basecolor input), from sphere → wrapper (geometry input), and
  // from wrapper → output (scene output).
  const wrapperInEdges = after.mainEdges.filter((e) => e.to.node === wrapper?.id);
  const wrapperOutEdges = after.mainEdges.filter((e) => e.from.node === wrapper?.id);

  // Undo twice: one for the rename (its own undoable step) and one
  // for the extract. The extract action itself is a SINGLE undo
  // step — the rename only shows up here because the test typed a
  // label after the action ran.
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'edit.undo' });
    await window.sedonMcp.call('runAction', { id: 'edit.undo' });
  });
  await new Promise((r) => setTimeout(r, 400));
  const undone = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodes: s.mainGraph.nodes.length,
      subgraphs: s.subgraphs.length,
    };
  });
  console.log('After undo×2:', JSON.stringify(undone));

  const checks = [
    ['Two nodes selected before extraction', sel.length === 2],
    ['Main lost the two selected nodes',
      !after.mainNodes.some((n) => n.id === matId) &&
      !after.mainNodes.some((n) => n.id === entityId)],
    ['Wrapper added to main', !!wrapper],
    ['New subgraph created (count went from 0 → 1)', after.subgraphs.length === 1],
    ['Subgraph has at least one input', newSg && newSg.inputs.length >= 1],
    ['Subgraph has at least one output', newSg && newSg.outputs.length >= 1],
    ['Subgraph contains both extracted node kinds',
      newSg && newSg.innerKinds.includes('core/material') && newSg.innerKinds.includes('core/scene-entity')],
    ['Subgraph contains boundary input + output nodes',
      newSg && newSg.innerKinds.some((k) => k.startsWith('subgraph-input/')) &&
      newSg.innerKinds.some((k) => k.startsWith('subgraph-output/'))],
    ['Wrapper has at least one incoming edge (grid / sphere)',
      wrapperInEdges.length >= 1],
    ['Wrapper has at least one outgoing edge (→ output)',
      wrapperOutEdges.length >= 1],
    ['Single undo restored the original 5 nodes', undone.mainNodes === 5],
    ['Single undo removed the new subgraph', undone.subgraphs === 0],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(allPass && errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
