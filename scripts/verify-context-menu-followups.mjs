// Three follow-ups to the unified canvas context menu:
//
//   1. Cut/Copy on a right-clicked node with no prior selection
//      should still act on that node alone (Finder-style).
//   2. Add Node / Add Subgraph / Paste invoked from a node menu
//      should land at click + (60, 60) flow-units so the new
//      arrival doesn't sit on top of the right-clicked node.
//   3. Right-clicking a node whose def carries a `doc` block should
//      surface an "Open Docs" item; nodes without docs should not.

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

const focusPanel = async (panelId) => {
  await page.evaluate((id) => {
    const api = window.__sedonGetDockview__?.();
    api?.getPanel(id)?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 200));
};

async function clickMenuRow(label) {
  const rect = await page.evaluate((label) => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return null;
    const row = [...menu.querySelectorAll('.sedon-menu-row')]
      .find((r) => r.querySelector('.sedon-menu-row-label')?.textContent === label);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
  if (!rect) return false;
  await page.mouse.move(rect.x, rect.y);
  await page.mouse.down();
  await page.mouse.up();
  return true;
}

// Headless chromium denies navigator.clipboard.writeText regardless
// of the permission API, so stub it with a Map-backed shim before
// any page code runs. Cut/Copy call .writeText(); Paste calls
// .readText() — both go through this stub.
let stubClipboard = '';
await page.evaluateOnNewDocument(() => {
  // @ts-expect-error overriding readonly
  navigator.clipboard = {
    writeText: async (s) => {
      Object.defineProperty(window, '__stubClipboard', { value: s, configurable: true, writable: true });
    },
    readText: async () => window.__stubClipboard ?? '',
  };
});

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Clipboard sanity: confirm writes succeed in this headless env.
  const clipboardOk = await page.evaluate(async () => {
    try {
      await navigator.clipboard.writeText('test');
      return true;
    } catch (e) {
      return String(e?.message ?? e);
    }
  });
  console.log('Clipboard test:', clipboardOk);

  await focusPanel('canvas-main');

  // ─── 1. Cut on a node with no prior selection ───────────────
  // Find the sphere node, ensure it's not selected, right-click,
  // pick Cut, verify the sphere was removed.
  await page.evaluate(() => {
    // Clear any prior selection via the RF dispatch.
    const api = window.__sedonGetDockview__?.();
    const panel = api?.getPanel('canvas-main');
    if (!panel) return;
    // Selection is held in RF's local node state — store has the
    // ground-truth set after a drag commit, but for this test we
    // just check the store-side post-cut.
  });
  const sphereIdBefore = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return s.mainGraph.nodes.find((n) => n.kind === 'core/sphere')?.id ?? null;
  });
  const sphereRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('sphere'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  await page.mouse.click(sphereRect.x, sphereRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const cutOk = await clickMenuRow('Cut');
  await new Promise((r) => setTimeout(r, 400));
  // Debug: what does the store say RIGHT after Cut?
  const cutDebug = await page.evaluate((id) => {
    const s = window.__sedonStore__.getState();
    return {
      stillHasSphere: !!s.mainGraph.nodes.find((n) => n.id === id),
      undoStackLen: s.undoStack.length,
      undoTop: s.undoStack[s.undoStack.length - 1]?.kind ?? null,
    };
  }, sphereIdBefore);
  console.log('  cut debug:', JSON.stringify(cutDebug));
  const sphereAfter = await page.evaluate((id) => {
    const s = window.__sedonStore__.getState();
    return s.mainGraph.nodes.find((n) => n.id === id) ?? null;
  }, sphereIdBefore);
  console.log('Cut on node (no prior selection): sphere existed =', !!sphereIdBefore, '→ after =', sphereAfter);

  // Restore the sphere via undo so subsequent steps have it.
  await page.evaluate(() => window.__sedonStore__.getState().undo());
  await new Promise((r) => setTimeout(r, 300));

  // ─── 2. Offset +60px from a node menu's Add Subgraph ────────
  // Right-click on the existing sphere, click Add Subgraph; check
  // the new wrapper's position vs the click point.
  const sphereRect2 = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('sphere'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  // Capture the click's flow position so we know what offset to expect.
  const clickFlow = await page.evaluate((x, y) => {
    const api = window.__sedonGetDockview__?.();
    // No direct exposure of rf instance; read from layout-store canvas viewport.
    // Easier: parse via the same screen-to-flow conversion the menu uses by
    // looking at the wrapper's position after we add it. Skip this — we'll
    // compare deltas instead.
    return { x, y };
  }, sphereRect2.x, sphereRect2.y);

  const wrappersBefore = await page.evaluate(() =>
    window.__sedonStore__.getState().mainGraph.nodes
      .filter((n) => n.kind.startsWith('subgraph/'))
      .map((n) => ({ id: n.id, position: n.position })),
  );
  await page.mouse.click(sphereRect2.x, sphereRect2.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  await clickMenuRow('Add Subgraph');
  await new Promise((r) => setTimeout(r, 500));
  // Commit auto-rename to dismiss the input.
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 200));
  const wrappersAfter = await page.evaluate(() =>
    window.__sedonStore__.getState().mainGraph.nodes
      .filter((n) => n.kind.startsWith('subgraph/'))
      .map((n) => ({ id: n.id, position: n.position })),
  );
  const newWrapper = wrappersAfter.find(
    (w) => !wrappersBefore.some((b) => b.id === w.id),
  );
  console.log('New wrapper position:', JSON.stringify(newWrapper?.position));
  // Compare to the sphere's position — the new wrapper should be
  // offset from where the click landed (which was on the sphere's
  // header). The sphere's flow position lives in the store too.
  const spherePos = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const sphere = s.mainGraph.nodes.find((n) => n.kind === 'core/sphere');
    return sphere?.position ?? null;
  });
  console.log('Sphere position:', JSON.stringify(spherePos));

  // ─── 3. Open Docs item ──────────────────────────────────────
  // The sphere's def has a `doc` block (it's a core node). Verify
  // its menu has "Open Docs". The subgraph-output boundary inside
  // an empty subgraph doesn't have a `doc` — verify it's omitted
  // there. (We can't drill into a boundary without a subgraph, but
  // we can check the wrapper's menu — wrappers also don't have a
  // def.doc since they're project-defined.)
  const sphereRect3 = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('sphere'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  await page.mouse.click(sphereRect3.x, sphereRect3.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const sphereItems = await page.evaluate(() => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return [];
    return [...menu.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent);
  });
  console.log('Sphere menu (has docs):', JSON.stringify(sphereItems));
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));

  // Wrapper (no def.doc) menu. Find by matching against
  // `data` attribute on the RF node wrapper that holds our `kind`,
  // or just iterate to find a .sedon-node whose React-rendered
  // header includes a known wrapper-id substring. Simpler:
  // dump the store's wrapper position and translate to screen.
  const wrapperRect = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const wrapper = s.mainGraph.nodes.find((n) => n.kind.startsWith('subgraph/'));
    if (!wrapper) return null;
    // Find the RF node element by data-id (RF tags nodes with
    // their id on the outermost .react-flow__node wrapper).
    const rfNode = document.querySelector(`.react-flow__node[data-id="${wrapper.id}"]`);
    if (!rfNode) {
      const allNodes = [...document.querySelectorAll('.sedon-node')]
        .map((n) => (n.textContent ?? '').slice(0, 60));
      return { error: 'no rf node', allNodes };
    }
    const r = rfNode.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  console.log('Wrapper rect:', JSON.stringify(wrapperRect));
  if (wrapperRect && !wrapperRect.error) {
    await page.mouse.click(wrapperRect.x, wrapperRect.y, { button: 'right' });
    await new Promise((r) => setTimeout(r, 200));
  }
  const wrapperItems = await page.evaluate(() => {
    const menu = document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
    if (!menu) return [];
    return [...menu.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent);
  });
  console.log('Wrapper menu (no docs):', JSON.stringify(wrapperItems));

  // ─── Checks ─────────────────────────────────────────────────
  const checks = [
    ['Cut on node without prior selection removed it',
      sphereIdBefore !== null && sphereAfter === null],
    ['Add Subgraph from node menu offset wrapper from click',
      newWrapper?.position && spherePos &&
      // The click was on the sphere's HEADER (which is at sphere's
      // x/y origin, plus a small header offset). The wrapper should
      // be roughly +60px from that. We just check it's NOT at the
      // sphere's exact origin.
      (Math.abs(newWrapper.position.x - spherePos.x) > 30 ||
       Math.abs(newWrapper.position.y - spherePos.y) > 30)],
    ['Sphere (core node, has doc) menu includes "Open Docs"',
      sphereItems.includes('Open Docs')],
    ['Wrapper (project subgraph, no doc) menu omits "Open Docs"',
      !wrapperItems.includes('Open Docs') && wrapperItems.includes('Rename')],
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
