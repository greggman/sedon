// Drive the user's palm-disappears repro through the production
// asset-double-click path, then watch what the preview pane's
// PreviewTile receives at each step.

import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', async (msg) => {
  const parts = await Promise.all(
    msg.args().map(async (arg) => {
      try { return await arg.evaluate((v) => typeof v === 'string' ? v : JSON.stringify(v)); }
      catch { return String(arg); }
    }),
  );
  logs.push(parts.join(' '));
});

await page.goto('http://localhost:8080/?debug=1', { waitUntil: 'networkidle2' });
// Wait for the debug-hook bindings to be installed.
await page.waitForFunction(
  () => typeof window.__sedonStore__ === 'function' && typeof window.__sedonOpenGraphInCanvas__ === 'function',
  { timeout: 10000 },
);

// Step 1: load Tree & Bush. Wait long enough that the initial paint
// finishes (all asset thumbnails commit + their renderers stabilise).
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'tree-bush');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3500));

// Enable debug logs BEFORE the user steps so we capture everything
// from step 2 onward.
await page.evaluate(() => { globalThis.__DEBUG_SCENE_PREVIEW__ = true; });

// Step 2: equivalent to double-click "Branch Palm" in the asset view.
// openGraphInCanvas pins the canvas pane to branch-palm AND flips
// currentEditingId — the same one-action that Asset.onDoubleClick does.
await page.evaluate(() => {
  console.log('=== step 2: openGraphInCanvas("branch-palm") ===');
  window.__sedonOpenGraphInCanvas__('branch-palm');
});
await new Promise((r) => setTimeout(r, 1500));

// Step 3: pin the preview pane to branch-palm. This is the equivalent
// of right-clicking the asset and choosing "Open in Preview" (or
// whatever the UI calls it).
await page.evaluate(() => {
  console.log('=== step 3: openGraphInPreview("branch-palm") ===');
  window.__sedonOpenGraphInPreview__('branch-palm');
  // Sanity check: report what panel state actually got set so we can
  // diagnose if the panel pin didn't take.
  const { useLayoutStore } = window;
  void useLayoutStore;
});
await new Promise((r) => setTimeout(r, 2000));

// Drive the radiusMin change through the actual UI — click on the
// input field, type the value, blur to commit. This is the path that
// the user reports the bug on; setInputValue-direct doesn't reproduce
// it. Anything that fires extra layout / focus / camera-state side
// effects only shows up via the real event sequence.
const setRadiusViaUI = async (val) => {
  await page.evaluate((val) => {
    console.log(`=== step ${val === 1 ? '4' : '5'}: setting radiusMin = ${val} via UI click+type ===`);
  }, val);
  // The radiusMin scrubber for the fronds sample-points node is the
  // ONE in the active canvas labelled `radiusMin` belonging to a node
  // that also has a `tipCount` input set to 14. Easiest selector:
  // find the row whose label text is exactly "radiusMin" and whose
  // node ancestor contains the fronds node's id. The node id we know.
  const nodeId = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const node = state.graph.nodes.find(
      (n) => n.kind === 'branch/sample-points' && n.inputValues?.tipCount === 14,
    );
    return node.id;
  });
  const inputBox = await page.evaluateHandle((nodeId) => {
    const nodeEl = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
    if (!nodeEl) throw new Error('node element not found in DOM');
    // Walk all elements; find the one whose own text is EXACTLY
    // 'radiusMin' (a label/span — not a parent that also contains
    // other labels). Then ascend until we find a container that
    // includes the scrub control next to that specific label.
    const candidates = Array.from(nodeEl.querySelectorAll('*'))
      .filter((el) => el.children.length === 0 && el.textContent === 'radiusMin');
    if (candidates.length === 0) throw new Error('no leaf element with text radiusMin');
    const label = candidates[0];
    // Look in the nearest ancestor that contains a .sedon-numinput-drag.
    // For multi-row layouts, ascend until we find one that contains
    // EXACTLY one scrub control — that's the radiusMin row.
    let ancestor = label.parentElement;
    while (ancestor) {
      const scrubs = ancestor.querySelectorAll('.sedon-numinput-drag');
      if (scrubs.length === 1) return scrubs[0];
      ancestor = ancestor.parentElement;
    }
    throw new Error('could not find scrub control unambiguously near radiusMin label');
  }, nodeId);
  // Click → enters typing mode → type the new value → press Enter.
  await inputBox.click();
  await new Promise((r) => setTimeout(r, 100));
  await page.keyboard.down('Meta');
  await page.keyboard.press('a');
  await page.keyboard.up('Meta');
  await page.keyboard.type(String(val));
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 2000));
};

await page.screenshot({ path: '/tmp/palm-step3.png' });
await setRadiusViaUI(1);
await page.screenshot({ path: '/tmp/palm-step4.png' });
await setRadiusViaUI(0);
await page.screenshot({ path: '/tmp/palm-step5.png' });

await browser.close();

console.log('\n========== CAPTURED LOG ==========\n');
for (const line of logs) console.log(line);
