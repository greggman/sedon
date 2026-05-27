// Tier-3 integration test: load the multi-layer-terrain demo, snapshot
// the canvas, mutate every solid-color albedo to black via the store
// API (same code path the UI uses), snapshot again, assert pixels
// actually changed.
//
// If the canvas does NOT change, the bug is between store and render.
// We then drill down: did setInputValue update node.inputValues? Did
// the fingerprint change? Did solid-color re-evaluate? Did the
// downstream terrain consumer re-evaluate? Each step is checkable
// from the debug hooks.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('error') || t.includes('Error')) console.log('[console]', t);
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function');
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
await new Promise((r) => setTimeout(r, 4000));
// Force continuous render so any canvas-redraw issue can't hide
// behind a missing rAF tick.
await page.evaluate(() => window.__sedonSetAnimating__(true));
await new Promise((r) => setTimeout(r, 500));

const rect = await page.evaluate(() => {
  const c = document.querySelector('.sedon-panel--preview canvas');
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
});

// Find the 4 albedo solid-color nodes. They're the first 4 nodes of
// kind 'core/solid-color' in the graph (positions y=ROW*1.5..4.5 vs
// the 5th splat node at y=ROW*5.5 — but we'll find by index since
// position is a UI hint that the eval doesn't see).
const probeBefore = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const cache = st.evalCache;
  const solids = st.graph.nodes.filter((n) => n.kind === 'core/solid-color');
  return {
    count: solids.length,
    nodes: solids.map((n) => ({
      id: n.id,
      color: n.inputValues?.color,
      fp: cache?.lastFingerprintByNodeId?.get(n.id) ?? null,
    })),
  };
});
console.log('before mutation:', JSON.stringify(probeBefore, null, 2));

const beforeShot = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
  path: '/tmp/color-before.png',
});

// Mutate: set first 4 solid-color albedos to black. Skip the splat
// (5th) so layer weights don't degenerate to all-zero.
const mutateResult = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const cacheBefore = {
    misses: st.evalCache?.stats?.cacheMisses ?? 0,
    hits: st.evalCache?.stats?.cacheHits ?? 0,
    pending: st.evalCache?.stats?.pendingHits ?? 0,
  };
  const solids = st.graph.nodes.filter((n) => n.kind === 'core/solid-color').slice(0, 4);
  for (const n of solids) {
    st.setInputValue(n.id, 'color', [0, 0, 0, 1]);
  }
  return { cacheBefore, mutated: solids.length };
});
console.log('mutate:', mutateResult);

await new Promise((r) => setTimeout(r, 2000));

const cacheAfter = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  return {
    misses: st.evalCache?.stats?.cacheMisses ?? 0,
    hits: st.evalCache?.stats?.cacheHits ?? 0,
    pending: st.evalCache?.stats?.pendingHits ?? 0,
  };
});
console.log('cache after:', cacheAfter);

const afterShot = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
  path: '/tmp/color-after.png',
});

// Probe everything: fingerprints + cache entry presence +
// downstream consumer fingerprints. If fps changed but canvas
// didn't, the bug is between cache and renderer.
const fpProbe = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const cache = st.evalCache;
  const solids = st.graph.nodes.filter((n) => n.kind === 'core/solid-color').slice(0, 4);
  const layers = st.graph.nodes.filter((n) => n.kind === 'terrain/layer');
  const material = st.graph.nodes.find((n) => n.kind === 'terrain/material');
  return {
    solids: solids.map((n) => ({
      id: n.id,
      color: n.inputValues?.color,
      fp: cache?.lastFingerprintByNodeId?.get(n.id) ?? null,
    })),
    layers: layers.map((n) => ({
      id: n.id,
      fp: cache?.lastFingerprintByNodeId?.get(n.id) ?? null,
    })),
    material: material ? {
      id: material.id,
      fp: cache?.lastFingerprintByNodeId?.get(material.id) ?? null,
    } : null,
  };
});
console.log('after mutation:', JSON.stringify(fpProbe, null, 2));

const diff = await page.evaluate(async (a, b) => {
  const dec = async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    off.getContext('2d').drawImage(bmp, 0, 0);
    return off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const A = await dec(a), B = await dec(b);
  let shifted = 0, totalLuma = 0, totalLumaB = 0;
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.max(
      Math.abs(A[i] - B[i]),
      Math.abs(A[i + 1] - B[i + 1]),
      Math.abs(A[i + 2] - B[i + 2]),
    );
    if (d > 5) shifted++;
    totalLuma += (A[i] + A[i + 1] + A[i + 2]) / 3;
    totalLumaB += (B[i] + B[i + 1] + B[i + 2]) / 3;
  }
  const px = A.length / 4;
  return {
    shifted,
    pixelCount: px,
    avgLumaBefore: Math.round(totalLuma / px),
    avgLumaAfter: Math.round(totalLumaB / px),
  };
}, Buffer.from(beforeShot).toString('base64'), Buffer.from(afterShot).toString('base64'));

console.log('\npixel diff:', diff);
console.log(`expect: significant shift AND avg luma to drop (black albedos → darker terrain)`);

// ---- Phase 2: drive the actual DOM color picker the way the user
//      would. Find a color input in the editor (the inline color
//      swatch on a solid-color node), reset to white via store, then
//      simulate the native picker's onChange event with a black hex.
//      If THIS doesn't change the canvas, the bug lives in the UI's
//      change wiring (despite the store call having worked in phase
//      1).

// Reset state: pump all 4 back to white so we have a clean baseline.
await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const solids = st.graph.nodes.filter((n) => n.kind === 'core/solid-color').slice(0, 4);
  for (const n of solids) st.setInputValue(n.id, 'color', [1, 1, 1, 1]);
});
await new Promise((r) => setTimeout(r, 1500));

// Open the inspector / find the visible color inputs in the node
// editor. React Flow renders nodes — find their color inputs.
const colorInputCount = await page.evaluate(() => {
  return document.querySelectorAll('input.sedon-colorinput[type="color"]').length;
});
console.log('color inputs visible in DOM:', colorInputCount);

if (colorInputCount > 0) {
  const whiteShot = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    encoding: 'binary',
  });

  // Drive the FIRST 4 color inputs to black via a synthetic input
  // event — that's how the native picker would notify React.
  await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input.sedon-colorinput[type="color"]')].slice(0, 4);
    for (const el of inputs) {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value',
      )?.set;
      setter?.call(el, '#000000');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 2000));

  const uiAfterShot = await page.screenshot({
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
    encoding: 'binary',
    path: '/tmp/color-ui-after.png',
  });

  const uiStoreCheck = await page.evaluate(() => {
    const st = window.__sedonStore__.getState();
    return st.graph.nodes
      .filter((n) => n.kind === 'core/solid-color')
      .slice(0, 4)
      .map((n) => ({ id: n.id, color: n.inputValues?.color }));
  });
  console.log('store after DOM event:', uiStoreCheck);

  const uiDiff = await page.evaluate(async (a, b) => {
    const dec = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const off = new OffscreenCanvas(bmp.width, bmp.height);
      off.getContext('2d').drawImage(bmp, 0, 0);
      return off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const A = await dec(a), B = await dec(b);
    let shifted = 0;
    for (let i = 0; i < A.length; i += 4) {
      const d = Math.max(
        Math.abs(A[i] - B[i]),
        Math.abs(A[i + 1] - B[i + 1]),
        Math.abs(A[i + 2] - B[i + 2]),
      );
      if (d > 5) shifted++;
    }
    return { shifted, pixelCount: A.length / 4 };
  }, Buffer.from(whiteShot).toString('base64'), Buffer.from(uiAfterShot).toString('base64'));
  console.log('UI-driven diff:', uiDiff);
}

await browser.close();
await server.stop();

const pass = diff.shifted > diff.pixelCount * 0.05 && diff.avgLumaAfter < diff.avgLumaBefore - 5;
console.log(`\n${pass ? 'PASS ✓' : 'FAIL ✗'} — store-API setInputValue ${pass ? 'changed' : 'did NOT change'} the rendered terrain`);
process.exit(pass ? 0 : 1);
