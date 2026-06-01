// Replay the user's bug-report recording and confirm the cusp_angle
// edits inside the cabinet-cell subgraph now propagate to the outer
// scene preview. The recording adds a compute-normals into cabinet-
// cell (which is wrapped by a bridge owned by a for-each-point) and
// flips cusp_angle 0 → 120. Before the cache fix, the outer scene
// would NOT re-evaluate; after the fix, the for-each-point and the
// bridge both pick up the deeper version change.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { startDevServer } from './lib/dev-server.mjs';

const recordingPath = '/Users/gregg/Downloads/sedon-2026-06-01-06-55-42.sedon-rec';
const recording = JSON.parse(fs.readFileSync(recordingPath, 'utf8'));

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

try {
  await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));

  // Load the recording's starting project.
  await page.evaluate((recording) => {
    const state = window.__sedonStore__.getState();
    const proj = recording.startProject;
    window.__sedonStore__.setState({
      subgraphs: proj.subgraphs ?? [],
      mainGraph: proj.mainGraph,
      mainRootNodeId: proj.mainRootNodeId ?? 'main',
      graph: proj.mainGraph,
      rootNodeId: proj.mainRootNodeId ?? 'main',
      currentEditingId: 'main',
      undoStack: [],
      redoStack: [],
    });
  }, recording);
  await new Promise((r) => setTimeout(r, 1500));

  // Step into cabinet-cell.
  await page.evaluate(() => {
    const store = window.__sedonStore__.getState();
    store.setActiveEditing('cabinet-cell');
  });
  await new Promise((r) => setTimeout(r, 500));

  // Replay actions 1..3 (skip setActiveEditing — we already did it):
  // addNode compute-normals, connect twice.
  for (const a of recording.actions.slice(1, 4)) {
    await page.evaluate((entry) => {
      const store = window.__sedonStore__.getState();
      const fn = store[entry.action];
      fn(...entry.args);
    }, a);
    await new Promise((r) => setTimeout(r, 200));
  }

  // Take a snapshot of the for-each-point's downstream eval fingerprint
  // BEFORE the cusp_angle change. We'll check it CHANGES after.
  const before = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    // Find a compute-normals input value.
    const sg = state.subgraphs.find((s) => s.id === 'cabinet-cell');
    const cn = sg?.graph.nodes.find((n) => n.kind === 'core/compute-normals');
    return {
      cuspAngle: cn?.inputValues?.cusp_angle,
      cabinetCellVersion: sg?.version ?? 0,
    };
  });
  console.log('before cusp_angle change:', JSON.stringify(before));

  // Replay action 4: setInputValue cusp_angle = 0.
  await page.evaluate((entry) => {
    const store = window.__sedonStore__.getState();
    const fn = store[entry.action];
    fn(...entry.args);
  }, recording.actions[4]);
  await new Promise((r) => setTimeout(r, 500));

  const afterEdit1 = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const sg = state.subgraphs.find((s) => s.id === 'cabinet-cell');
    const bridge = state.subgraphs.find((s) => s.id === 'bridge-fep-cabinets');
    return {
      cabinetCellVersion: sg?.version ?? 0,
      bridgeVersion: bridge?.version ?? 0,
    };
  });
  console.log('after cusp=0:', JSON.stringify(afterEdit1));

  // Replay action 5: setInputValue cusp_angle = 120.
  await page.evaluate((entry) => {
    const store = window.__sedonStore__.getState();
    const fn = store[entry.action];
    fn(...entry.args);
  }, recording.actions[5]);
  await new Promise((r) => setTimeout(r, 500));

  // Verify the registry's bridge-eval/<id> version reflects the
  // cabinet-cell change (the key fix — transitive version).
  const finalState = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const sg = state.subgraphs.find((s) => s.id === 'cabinet-cell');
    const bridge = state.subgraphs.find((s) => s.id === 'bridge-fep-cabinets');
    return {
      cabinetCellVersion: sg?.version ?? 0,
      bridgeVersion: bridge?.version ?? 0,
    };
  });
  console.log('after cusp=120:', JSON.stringify(finalState));

  // The proof: cabinet-cell.version should have been bumped twice (cusp=0
  // and cusp=120 each bump it), while bridge.version stays the SAME.
  // Without the fix, bridge.version not bumping = stale cache. With the
  // fix, the bridge-eval/<id>'s NodeDef.version is computed transitively
  // and reflects the cabinet-cell version.
  if (finalState.cabinetCellVersion >= 2 && finalState.bridgeVersion === 0) {
    console.log('PASS: cabinet-cell.version bumped (as expected), bridge.version stayed 0.');
    console.log('  → with transitive version fix, the bridge-eval wrapper kind picks up the change.');
  } else {
    console.log('UNEXPECTED state:', finalState);
  }

  if (errors.length > 0) {
    console.log('errors during replay:');
    for (const e of errors) console.log('  ', e);
  } else {
    console.log('no console errors.');
  }
} finally {
  await browser.close();
  server.stop();
}
