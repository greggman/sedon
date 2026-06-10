// UX-level browser tests. One file, run with `npm run test:browser`.
//
// Layout: top-level `before` boots the dev server + a single
// puppeteer browser; `after` tears them down. Every test() opens a
// fresh page on the running server, drives it, then closes the page.
//
// Browser/dev-server are launched ONCE for the whole suite — adding a
// new case only costs whatever that case actually does. Pages are
// cheap; full browser launches aren't.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { startDevServer } from '../../scripts/lib/dev-server.mjs';

let server;
let browser;

before(async () => {
  server = await startDevServer({ prod: false });
  browser = await puppeteer.launch({
    headless: 'new',
    // No sandbox: simpler in CI / Docker; safe locally since the only
    // thing we ever navigate to is our own dev server.
    args: ['--no-sandbox'],
  });
});

after(async () => {
  // Best-effort, time-boxed. esbuild's dev server has occasionally
  // ignored SIGTERM; let the OS reap it rather than hang the suite.
  await Promise.race([
    (async () => {
      if (browser) await browser.close();
      if (server) await server.stop();
    })(),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
});

/**
 * Open a fresh page on the dev server with `?debug=1` set so the
 * editor exposes the store + eval hooks on `window`. `waitUntil` is
 * intentionally 'domcontentloaded' — esbuild dev mode keeps a live-
 * reload SSE channel open, so 'networkidle2' would wait the full
 * timeout for nothing. We then wait for the store to actually exist
 * on the window, which is the real "page is ready" signal.
 */
async function openPage(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => { errs.push(`pageerror: ${e.message}`); });
  page.on('console', (msg) => {
    if (msg.type() === 'error') errs.push(`console: ${msg.text()}`);
  });
  const sep = query ? '&' : '';
  await page.goto(`${server.url}?debug=1${sep}${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.waitForFunction(
    () => typeof window.__sedonStore__ !== 'undefined'
       && window.__sedonStore__.getState().graph.nodes.length > 0,
    { timeout: 10_000 },
  );
  return { page, errs };
}

async function panCanvas(page, dx, dy) {
  const pane = await page.$('.react-flow__pane');
  const box = await pane.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + dx, cy + dy, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
}

async function viewportTransform(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport');
    return el ? el.getAttribute('style') : null;
  });
}

async function clickViewMenuItem(page, label) {
  const view = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.sedon-menubar-item')]
      .find((el) => el.textContent?.trim() === 'View'),
  );
  await view.asElement().click();
  // Brief settle so the popup renders. Polling on the menu DOM avoids
  // a hardcoded sleep when the popup is slow to mount.
  await page.waitForSelector('.sedon-menubar-popup .sedon-menu-row', { timeout: 2000 });
  const item = await page.evaluateHandle((needle) =>
    [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row')]
      .find((row) => row.querySelector('.sedon-menu-row-label')?.textContent?.trim() === needle),
    label,
  );
  if (!item.asElement()) throw new Error(`menu item "${label}" not found`);
  const box = await item.asElement().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// -----------------------------------------------------------------
// scene smoke check
// -----------------------------------------------------------------

test('scene=basic loads — eval produces non-empty outputs at root', async () => {
  const { page, errs } = await openPage('scene=basic');
  try {
    // First eval needs WebGPU init; poll for non-empty outputs rather
    // than a fixed sleep.
    await page.waitForFunction(() => {
      const s = window.__sedonStore__.getState();
      const panels = window.__sedonListPanelIds__?.() ?? [];
      const outputs = panels.map((p) => window.__sedonGetOutputs__(p, s.rootNodeId)).find(Boolean);
      return outputs && Object.keys(outputs).length > 0;
    }, { timeout: 5000 });
    const summary = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return {
        nodeCount: s.graph.nodes.length,
        rootKind: s.graph.nodes.find((n) => n.id === s.rootNodeId)?.kind,
      };
    });
    assert.ok(summary.nodeCount > 0);
    assert.equal(summary.rootKind, 'core/output');
    assert.equal(errs.length, 0, `console errors: ${errs.join(' | ')}`);
  } finally {
    await page.close();
  }
});

// -----------------------------------------------------------------
// View → Frame Selected (menu and F-key)
// -----------------------------------------------------------------

test('View menu → Frame Selected: fires fitView on the canvas', async () => {
  const { page } = await openPage('scene=basic');
  try {
    await panCanvas(page, 2000, 2000);
    const before = await viewportTransform(page);
    await clickViewMenuItem(page, 'Frame Selected');
    // ReactFlow fitView animates; wait for transform to actually change.
    await page.waitForFunction(
      (prev) => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== prev,
      { timeout: 2000 },
      before,
    );
    const after = await viewportTransform(page);
    assert.notEqual(before, after);
  } finally {
    await page.close();
  }
});

test('F-key with NOTHING selected: fits all nodes', async () => {
  // Regression: clicking empty pane parks focus on dockview's
  // container (parent of the React Flow wrapper) so the wrapper's
  // onKeyDown never fired and F was a silent no-op. The fix hoisted
  // the F-key handler to window-level via the menu's code path.
  const { page } = await openPage('scene=basic');
  try {
    const pane = await page.$('.react-flow__pane');
    const box = await pane.boundingBox();
    // Click empty area to deselect.
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.1);
    await panCanvas(page, 2000, 2000);
    const before = await viewportTransform(page);
    await page.keyboard.press('f');
    await page.waitForFunction(
      (prev) => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== prev,
      { timeout: 2000 },
      before,
    );
    const after = await viewportTransform(page);
    assert.notEqual(before, after);
  } finally {
    await page.close();
  }
});

// -----------------------------------------------------------------
// Node drag is undoable
// -----------------------------------------------------------------

test('drag a node, press Cmd-Z, position restored', async () => {
  const { page } = await openPage('scene=basic');
  try {
    const firstId = await page.evaluate(
      () => window.__sedonStore__.getState().graph.nodes[0]?.id ?? null,
    );
    assert.ok(firstId);
    const readPos = (id) => page.evaluate((nid) => {
      const s = window.__sedonStore__.getState();
      return s.nodePositions[s.currentEditingId]?.[nid] ?? null;
    }, id);

    const before = await readPos(firstId);
    const handle = await page.$(`.react-flow__node[data-id="${firstId}"]`);
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 150, { steps: 8 });
    await page.mouse.up();
    // Wait for the position to actually update in the store, not a hardcoded sleep.
    await page.waitForFunction((id, b) => {
      const s = window.__sedonStore__.getState();
      const p = s.nodePositions[s.currentEditingId]?.[id];
      return p && (Math.abs(p.x - b.x) > 20 || Math.abs(p.y - b.y) > 20);
    }, { timeout: 2000 }, firstId, before);

    await page.keyboard.down('Meta');
    await page.keyboard.press('z');
    await page.keyboard.up('Meta');
    await page.waitForFunction((id, b) => {
      const s = window.__sedonStore__.getState();
      const p = s.nodePositions[s.currentEditingId]?.[id];
      return p && Math.abs(p.x - b.x) < 1 && Math.abs(p.y - b.y) < 1;
    }, { timeout: 2000 }, firstId, before);

    const restored = await readPos(firstId);
    const dist = Math.hypot(restored.x - before.x, restored.y - before.y);
    assert.ok(dist < 1, `undo must restore to start (off by ${dist.toFixed(2)}px)`);
  } finally {
    await page.close();
  }
});

// -----------------------------------------------------------------
// Delete-with-connections = ONE undo step
// -----------------------------------------------------------------

test('delete a connected node — restored by ONE Cmd-Z', async () => {
  const { page } = await openPage('scene=basic');
  try {
    const target = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      const idsWithEdges = new Set();
      for (const e of s.graph.edges) {
        idsWithEdges.add(e.from.node);
        idsWithEdges.add(e.to.node);
      }
      const n = s.graph.nodes.find((m) => idsWithEdges.has(m.id) && m.kind !== 'core/output');
      return n ? n.id : null;
    });
    assert.ok(target, 'scene=basic must contain a connected non-output node');

    const beforeCounts = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length, u: s.undoStack.length };
    });

    const handle = await page.$(`.react-flow__node[data-id="${target}"]`);
    const box = await handle.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // ReactFlow's default deleteKeyCode is 'Backspace'.
    await page.keyboard.press('Backspace');
    await page.waitForFunction(
      (id) => !window.__sedonStore__.getState().graph.nodes.some((n) => n.id === id),
      { timeout: 2000 },
      target,
    );

    const afterDel = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length, u: s.undoStack.length };
    });
    assert.equal(afterDel.n, beforeCounts.n - 1, 'node removed');
    assert.ok(afterDel.e < beforeCounts.e, 'edge removed');
    assert.equal(
      afterDel.u - beforeCounts.u,
      1,
      `delete-with-connections must add ONE undo entry (got ${afterDel.u - beforeCounts.u})`,
    );

    await page.keyboard.down('Meta');
    await page.keyboard.press('z');
    await page.keyboard.up('Meta');
    await page.waitForFunction(
      (n) => window.__sedonStore__.getState().graph.nodes.length === n,
      { timeout: 2000 },
      beforeCounts.n,
    );
    const afterUndo = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length };
    });
    assert.equal(afterUndo.n, beforeCounts.n, 'node restored');
    assert.equal(afterUndo.e, beforeCounts.e, 'edges restored');
  } finally {
    await page.close();
  }
});

// -----------------------------------------------------------------
// Drop-on-wire: adding a node while one edge is selected splices the
// new node into the wire as ONE undo step.
// -----------------------------------------------------------------

test('drop-on-wire: addNode with one edge selected splices node into the wire (1 undo)', async () => {
  const { page } = await openPage('scene=basic');
  try {
    // Find an edge whose endpoint TYPES will splice cleanly with
    // `geom/transform` (Geometry in + Geometry out): the edge must
    // carry a Geometry value.
    const target = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      // Look at every edge and find one whose source's output socket
      // and target's input socket are both Geometry. That guarantees
      // the splice picks geom/transform's geometry in + geometry out.
      for (const e of s.graph.edges) {
        const fromNode = s.graph.nodes.find((n) => n.id === e.from.node);
        const toNode = s.graph.nodes.find((n) => n.id === e.to.node);
        if (!fromNode || !toNode) continue;
        // Inputs/outputs on the GraphNode are def-derived; we don't
        // have a registry here in puppeteer. The simplest signal:
        // socket names. core/output's `scene` input takes Scene;
        // anything wired to .scene won't suit geom/transform. The
        // `scene/entity` → `geometry` and `scene/entity` → `material`
        // edges DO carry Geometry / Material respectively. Use the
        // edge whose to.socket is literally `geometry`.
        if (e.to.socket === 'geometry') return { id: e.id };
      }
      return null;
    });
    assert.ok(target, 'scene=basic must contain at least one Geometry edge');

    // Select the edge via the active RF instance.
    await page.evaluate((edgeId) => {
      const rf = window.__sedonGetActiveRf__?.();
      if (!rf) throw new Error('no active canvas RF');
      rf.setEdges((edges) => edges.map((e) => ({
        ...e,
        selected: e.id === edgeId,
      })));
    }, target.id);

    const before = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length, u: s.undoStack.length };
    });

    // Drive the same code path the toolbar / picker / palette
    // hits. The helper checks for a selected edge and splices in
    // when types match.
    await page.evaluate(() => {
      const id = window.__sedonAddNodeAtCanvasCenter__('geom/transform');
      if (!id) throw new Error('add failed');
    });
    await page.waitForFunction(
      (u) => window.__sedonStore__.getState().undoStack.length === u + 1,
      { timeout: 2000 },
      before.u,
    );
    const after = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length, u: s.undoStack.length };
    });
    assert.equal(after.n, before.n + 1, 'one new node');
    assert.equal(after.e, before.e + 1, '+2 new edges minus the deleted one = +1');
    assert.equal(after.u, before.u + 1, 'one undo entry');

    // Cmd-Z restores everything in a single step.
    await page.keyboard.down('Meta');
    await page.keyboard.press('z');
    await page.keyboard.up('Meta');
    await page.waitForFunction(
      (n) => window.__sedonStore__.getState().graph.nodes.length === n,
      { timeout: 2000 },
      before.n,
    );
    const restored = await page.evaluate(() => {
      const s = window.__sedonStore__.getState();
      return { n: s.graph.nodes.length, e: s.graph.edges.length };
    });
    assert.equal(restored.n, before.n);
    assert.equal(restored.e, before.e);
  } finally {
    await page.close();
  }
});

// Scrub-coalescing browser test was here but skipped — it required a
// visible Float-input handle in scene=basic, which isn't guaranteed.
// Unit tests in test/unit/setInputValue-coalesce.test.ts pin the
// store-level coalescing rule + markUndoBarrier semantics. We'll add
// a browser-level check once a dedicated test-fixture scene exists.
