// Verify the for-each-point docs page actually shows its sample (live
// preview of the body subgraph being iterated). The fix in the
// adjacent check-for-each-point.mjs covered the EDITOR demo; this one
// covers the DOCS page, which uses a different mount path (the docs
// entry seeds the store from `def.doc.sampleGraph()` then renders the
// DocsPage / DocsSamplePreview tree).
//
// Asserts:
//   • page loads without console / page errors
//   • the for-each-point node in the store has its body bound and
//     mirror sockets present
//   • the in-canvas eval landed in canvas-data with N distinct cube
//     entities (one per grid point), proving the body subgraph was
//     in the registry by the time eval ran

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
const logs = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.text().startsWith('[fep]') || msg.text().startsWith('[docs-mount]')) logs.push(msg.text());
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

try {
  await page.goto(`${server.url}docs/nodes/core/for-each-point/?debug=1`, { waitUntil: 'networkidle2' });
  // The docs entry exposes the same debug hooks the editor entry does
  // when ?debug=1. Wait for the store to be ready.
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2000));

  const summary = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const feNode = state.graph.nodes.find((n) => n.kind === 'core/for-each-point');
    const panelIds = (window.__sedonListPanelIds__?.() ?? []);
    let outputs;
    for (const pid of panelIds) {
      const o = window.__sedonGetOutputs__?.(pid, feNode?.id);
      if (o) { outputs = o; break; }
    }
    return {
      mainNodeKinds: state.graph.nodes.map((n) => n.kind),
      subgraphIds: state.subgraphs.map((s) => s.id),
      feBridgeId: feNode?.inputValues?.__bridgeId,
      sceneEntityCount: outputs?.scene?.entities?.length ?? null,
      distinctGeometryRefs: outputs?.scene?.entities
        ? new Set(outputs.scene.entities.map((e) => e.geometry)).size
        : null,
    };
  });

  console.log(JSON.stringify(summary, null, 2));
  console.log('fep logs:');
  for (const l of logs) console.log('  ', l);
  if (errors.length > 0) {
    console.log('errors:');
    for (const e of errors) console.log('  ', e);
  }

  const failures = [];
  if (errors.length > 0) failures.push(`console / page errors: ${errors.length}`);
  if (!summary.subgraphIds.includes('docs-fep-cube')) failures.push('body subgraph docs-fep-cube not in state.subgraphs');
  if (typeof summary.feBridgeId !== 'string' || summary.feBridgeId === '') {
    failures.push(`__bridgeId=${JSON.stringify(summary.feBridgeId)}`);
  } else if (!summary.subgraphIds.includes(summary.feBridgeId)) {
    failures.push(`bridge subgraph ${summary.feBridgeId} not in state.subgraphs`);
  }
  if (summary.sceneEntityCount !== 9) failures.push(`expected 9 entities, got ${summary.sceneEntityCount}`);
  if (summary.distinctGeometryRefs !== summary.sceneEntityCount) {
    failures.push(`expected ${summary.sceneEntityCount} distinct geometry refs, got ${summary.distinctGeometryRefs}`);
  }

  if (failures.length > 0) {
    console.error('FAIL:');
    for (const f of failures) console.error('  ', f);
    process.exitCode = 1;
  } else {
    console.log('OK: docs sample renders 9 distinct cube entities');
  }
} finally {
  await browser.close();
  server.stop();
}
