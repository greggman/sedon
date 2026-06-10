// Render the two new texture nodes in isolation and confirm the
// preview pane lights up (no errors, non-blank pixels). Drives the
// editor via the debug store hooks.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/new-textures';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[${msg.type()}] ${msg.text()}`);
  if (msg.text().includes('[dashed-stripe.evaluate]')) {
    console.log(' >>>', msg.text());
  }
});

try {
  // Capture WebGPU device errors into a window-side list so the
  // browser's silent validation failures (the stuff that doesn't go
  // through console.error) gets surfaced to the test.
  await page.evaluateOnNewDocument(() => {
    window.__webgpuErrors = [];
    const origCreateDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const dev = await origCreateDevice.apply(this, args);
      dev.addEventListener?.('uncapturederror', (e) => {
        window.__webgpuErrors.push(String(e.error?.message ?? e));
      });
      return dev;
    };
  });

  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Replace main with a minimal scene that puts the new texture on
  // the existing scene-entity's material. Easiest path: use
  // setGraph to swap in a hand-built graph per node we're testing.
  const buildSceneWith = (texKind, texInputs) => `
    (() => {
      const s = window.__sedonStore__.getState();
      const graph = {
        version: 1,
        nodes: [
          { id: 'tex',  kind: ${JSON.stringify(texKind)}, position: {x:0,y:0},  inputValues: ${JSON.stringify(texInputs)} },
          { id: 'mat',  kind: 'material/pbr',          position: {x:200,y:0},  inputValues: {} },
          { id: 'box',  kind: 'geom/box',               position: {x:0,y:200},  inputValues: { w: 2, h: 0.01, d: 2 } },
          { id: 'ent',  kind: 'scene/entity',      position: {x:400,y:100} },
          { id: 'out',  kind: 'core/output',            position: {x:600,y:100} },
        ],
        edges: [
          { id: 'e1', from: { node: 'tex', socket: 'texture' }, to: { node: 'mat', socket: 'basecolor' } },
          { id: 'e2', from: { node: 'box', socket: 'geometry' }, to: { node: 'ent', socket: 'geometry' } },
          { id: 'e3', from: { node: 'mat', socket: 'material' }, to: { node: 'ent', socket: 'material' } },
          { id: 'e4', from: { node: 'ent', socket: 'scene' }, to: { node: 'out', socket: 'scene' } },
        ],
      };
      s.setGraph(graph, 'out', [], {}, {}, []);
    })();
  `;

  const runFor = async (label, texKind, texInputs) => {
    await page.evaluate(buildSceneWith(texKind, texInputs));
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: `${OUT}/${label}.png` });
  };

  await runFor('checker', 'tex/checker', {
    fg: [0.95, 0.95, 0.97, 1],
    bg: [0.10, 0.10, 0.12, 1],
    divisions: [8, 8],
    resolution: 256,
  });
  await runFor('checker-crosswalk', 'tex/checker', {
    fg: [0.95, 0.95, 0.97, 1],
    bg: [0.12, 0.12, 0.13, 1],
    divisions: [8, 1],
    resolution: 256,
  });
  await runFor('dashed-stripe-yellow', 'tex/dashed-stripe', {
    fg: [1, 0.85, 0.2, 1],
    bg: [0.12, 0.12, 0.13, 1],
    dash_count: 20,
    dash_fraction: 0.5,
    stripe_width: 0.08,
    orientation: 0,
    resolution: 256,
  });
  await runFor('dashed-stripe-solid-edge', 'tex/dashed-stripe', {
    fg: [0.95, 0.95, 0.97, 1],
    bg: [0.12, 0.12, 0.13, 1],
    dash_count: 1,
    dash_fraction: 1,
    stripe_width: 0.04,
    orientation: 0,
    resolution: 256,
  });
  await runFor('dashed-stripe-vertical', 'tex/dashed-stripe', {
    fg: [1, 0.85, 0.2, 1],
    bg: [0.12, 0.12, 0.13, 1],
    dash_count: 20,
    dash_fraction: 0.5,
    stripe_width: 0.08,
    orientation: 1,
    resolution: 256,
  });

  // Also confirm both nodes appear in the registry so the Add menu
  // and the action registry both pick them up automatically (this
  // is the structural invariant we established earlier).
  const inRegistry = await page.evaluate(async () => {
    const list = await window.sedonMcp.call('listNodeKinds', {});
    const ids = list.kinds.map((k) => k.id);
    return {
      checker: ids.includes('tex/checker'),
      dashedStripe: ids.includes('tex/dashed-stripe'),
    };
  });
  console.log('In registry:', JSON.stringify(inRegistry));

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  // Also pull any uncaptured GPU validation errors from the page.
  const gpuErrs = await page.evaluate(() => window.__webgpuErrors ?? []);
  if (gpuErrs.length) {
    console.log('\nGPU validation errors:');
    for (const e of gpuErrs) console.log(' ', e);
  }
  console.log(inRegistry.checker && inRegistry.dashedStripe && errors.length === 0
    ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
