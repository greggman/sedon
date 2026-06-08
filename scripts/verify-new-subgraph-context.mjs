// Verify the context-sensitive behaviour of "New Subgraph…":
//
//   A. Click the asset view to focus it, fire add.new-subgraph.
//      EXPECT: a new subgraph exists; the main graph's node count
//      is unchanged (no wrapper was placed); editing context hopped
//      INTO the new subgraph.
//
//   B. Reset (file.new), click the canvas to focus it, fire
//      add.new-subgraph.
//      EXPECT: a new subgraph exists; the main graph gained ONE
//      `subgraph/<id>` wrapper node; editing context is still on
//      main (we hopped back).

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

// Auto-accept native confirms (file.new) and prompts (window.prompt
// for the new subgraph name).
page.on('dialog', (d) => {
  if (d.type() === 'prompt') void d.accept('AutoTestSubgraph');
  else void d.accept();
});

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 3000));

  // Snapshot baseline.
  const baseline = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodeCount: s.mainGraph.nodes.length,
      subgraphCount: s.subgraphs.length,
      currentEditing: s.currentEditingId,
    };
  });
  console.log('BASELINE:', JSON.stringify(baseline));

  // Focus a panel by id via DockView's imperative API. The debug
  // build exposes `__sedonGetDockview__` on window; we set the
  // active panel directly (same end state as a real click, without
  // depending on synthetic mouse events reaching DockView's
  // internal listeners).
  const focusPanel = async (panelId) => {
    const ok = await page.evaluate((id) => {
      const api = window.__sedonGetDockview__?.();
      if (!api) return { error: 'no dockview api' };
      const panel = api.getPanel(id);
      if (!panel) return { error: `no panel ${id}`, available: api.panels.map((p) => p.id) };
      panel.api.setActive();
      return { ok: true, kind: panel.view.contentComponent };
    }, panelId);
    if (!ok.ok) throw new Error(`focusPanel(${panelId}): ${JSON.stringify(ok)}`);
    await new Promise((r) => setTimeout(r, 150));
  };

  // ─── Case A: asset view focused ─────────────────────────────
  await focusPanel('assets-main');

  // Run the action via MCP (cleanest — bypasses menu mechanics).
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 300));

  const afterAsset = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodeCount: s.mainGraph.nodes.length,
      subgraphCount: s.subgraphs.length,
      currentEditing: s.currentEditingId,
      mainKinds: s.mainGraph.nodes.map((n) => n.kind),
    };
  });
  console.log('AFTER asset-view create:', JSON.stringify(afterAsset));

  // ─── Reset for case B ───────────────────────────────────────
  await page.evaluate(async () => {
    window.__sedonStore__.getState().markClean();
    await window.sedonMcp.call('runAction', { id: 'file.new' });
  });
  await new Promise((r) => setTimeout(r, 500));

  const afterReset = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return { mainNodeCount: s.mainGraph.nodes.length, subgraphCount: s.subgraphs.length };
  });
  console.log('AFTER reset:', JSON.stringify(afterReset));

  // ─── Case B: canvas focused ─────────────────────────────────
  await focusPanel('canvas-main');

  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 500));

  const afterCanvas = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      mainNodeCount: s.mainGraph.nodes.length,
      subgraphCount: s.subgraphs.length,
      currentEditing: s.currentEditingId,
      mainKinds: s.mainGraph.nodes.map((n) => n.kind),
      newWrapperKinds: s.mainGraph.nodes.map((n) => n.kind).filter((k) => k.startsWith('subgraph/')),
    };
  });
  console.log('AFTER canvas create:', JSON.stringify(afterCanvas));

  const checks = [
    ['asset case: subgraph was created', afterAsset.subgraphCount === baseline.subgraphCount + 1],
    ['asset case: NO wrapper added to main', afterAsset.mainNodeCount === baseline.mainNodeCount],
    ['asset case: hopped INTO new subgraph',
      afterAsset.currentEditing !== 'main' && afterAsset.currentEditing !== baseline.currentEditing],
    ['canvas case: subgraph was created (1 net new)', afterCanvas.subgraphCount === 1],
    ['canvas case: wrapper added to main (mainNodeCount = base + 1)',
      afterCanvas.mainNodeCount === afterReset.mainNodeCount + 1],
    ['canvas case: wrapper is the new subgraph kind', afterCanvas.newWrapperKinds.length === 1],
    ['canvas case: still editing main (hopped back)', afterCanvas.currentEditing === 'main'],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(allPass && errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
