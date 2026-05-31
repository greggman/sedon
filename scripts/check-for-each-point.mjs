// Smoke-test the `for-each-point` demo end-to-end in a real browser.
// Drives the editor through the debug API exposed at `?debug=1`,
// loads the demo, waits for eval to settle, then inspects the
// for-each-point node's output to assert:
//   • the demo loads without console errors or page errors
//   • the body subgraph (`subgraph/cabinet-cell`) is in the registry
//   • the for-each-point node evaluated and emitted 16 entities
//     (4×4 grid)
//
// Catches regressions in the iteration evaluator + the editor's
// dynamic-extras plumbing in one shot. The hooks-order bug from
// commit-before-last would have surfaced here as a pageerror.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

try {
  await page.goto(`${server.url}?debug=1&scene=for-each-point`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

  // Give eval a moment to land. The grid-distribute → for-each-point
  // chain is pure CPU plus a few GPU uploads for the cube primitive
  // × 16 iterations; 2s is generous.
  await new Promise((r) => setTimeout(r, 2000));

  const summary = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const feNode = state.graph.nodes.find((n) => n.kind === 'core/for-each-point');
    if (!feNode) return { error: 'no for-each-point node in graph' };
    const panelIds = window.__sedonListPanelIds__();
    // Find which panel has eval outputs (Preview / canvas / asset
    // thumbnail — any of them will do for verifying eval ran).
    let outputs;
    for (const pid of panelIds) {
      const o = window.__sedonGetOutputs__(pid, feNode.id);
      if (o) { outputs = o; break; }
    }
    return {
      feNodeId: feNode.id,
      bodyKind: feNode.inputValues?.__body,
      extraInputs: (feNode.extraInputs ?? []).map((i) => `${i.name}:${i.type}`),
      extraOutputs: (feNode.extraOutputs ?? []).map((o) => `${o.name}:${o.type}`),
      subgraphCount: state.subgraphs.length,
      cabinetCellRegistered: state.subgraphs.some((s) => s.id === 'cabinet-cell'),
      sceneEntityCount: outputs?.scene?.entities?.length ?? null,
      // Distinct geometry refs across iterations? A regression where
      // the eval cache returns the same Geometry for every iteration
      // (because per-iteration fingerprints collide) would land here
      // as `1`. With the fingerprint fix every iteration produces a
      // unique GeometryValue, so the count should match the entity
      // count.
      distinctGeometryRefs: outputs?.scene?.entities
        ? new Set(outputs.scene.entities.map((e) => e.geometry)).size
        : null,
    };
  });

  const failures = [];
  if (errors.length > 0) failures.push(`console / page errors: ${errors.length}`);
  if (!summary.cabinetCellRegistered) failures.push('cabinet-cell subgraph not registered');
  if (summary.bodyKind !== 'subgraph/cabinet-cell') failures.push(`__body=${JSON.stringify(summary.bodyKind)}`);
  if (summary.sceneEntityCount === null) failures.push('for-each-point produced no eval output');
  if (summary.sceneEntityCount !== 16) failures.push(`expected 16 merged entities (4×4 grid), got ${summary.sceneEntityCount}`);
  if (summary.distinctGeometryRefs !== summary.sceneEntityCount) {
    failures.push(`expected ${summary.sceneEntityCount} distinct geometry refs (each iteration produces its own translated cube), got ${summary.distinctGeometryRefs}`);
  }

  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) {
    console.log('errors:');
    for (const e of errors) console.log('  ', e);
  }
  if (failures.length > 0) {
    console.error('FAIL:');
    for (const f of failures) console.error('  ', f);
    process.exitCode = 1;
  } else {
    console.log('OK: for-each-point demo loaded and emitted 16 cabinet entities');
  }
} finally {
  await browser.close();
  server.stop();
}
