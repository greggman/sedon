// Load tree-bush, edit Branch Canopy. Take a baseline render at the
// authored params; then push the canopy into a "degenerate / few
// branches" config (small attractorRadius so the trunk barely sees
// the canopy) and take a second render. Used to verify the radius
// rescale fix produces a sensible thin tapered stick instead of a
// uniform-rootRadius club, and that leaves still appear.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[err]', msg.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 3000));

const setup = await page.evaluate(() => {
  const subs = window.__sedonStore__.getState().subgraphs;
  const canopy = subs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
  const sc = canopy.graph.nodes.find((n) => n.kind === 'branch/space-colonization');
  const sample = canopy.graph.nodes.find((n) => n.kind === 'branch/sample-points');
  return { canopyId: canopy.id, scId: sc.id, sampleId: sample.id, scInputs: sc.inputValues };
});
console.log('setup:', setup);

await page.evaluate((cid) => window.__sedonOpenGraphInCanvas__(cid, 'canvas-main'),
  setup.canopyId);
await new Promise((r) => setTimeout(r, 1500));

async function readBranchSig() {
  return page.evaluate(({ scId, sampleId }) => {
    const scOut = window.__sedonGetOutputs__('canvas-main', scId);
    const sampleOut = window.__sedonGetOutputs__('canvas-main', sampleId);
    let radii = null;
    const bg = scOut?.branches;
    if (bg?.radii) {
      const arr = Array.from(bg.radii);
      arr.sort((a, b) => a - b);
      radii = {
        n: arr.length,
        branchCount: bg.branchCount,
        min: arr[0]?.toFixed(3),
        p25: arr[Math.floor(arr.length * 0.25)]?.toFixed(3),
        p50: arr[Math.floor(arr.length * 0.50)]?.toFixed(3),
        p75: arr[Math.floor(arr.length * 0.75)]?.toFixed(3),
        max: arr[arr.length - 1]?.toFixed(3),
      };
    }
    const leafCount = sampleOut?.points?.count ?? null;
    return { radii, leafCount };
  }, { scId: setup.scId, sampleId: setup.sampleId });
}

async function shot(tag) {
  // Find the BIGGEST canvas on the page — that's the main scene
  // preview, not an in-node thumbnail (which are small).
  const canvas = await page.evaluateHandle(() => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const area = c.clientWidth * c.clientHeight;
      if (!best || area > best.area) best = { el: c, area };
    }
    return best?.el ?? null;
  });
  if (canvas) {
    await canvas.asElement()?.screenshot({ path: `/tmp/canopy-${tag}.png` });
    console.log(`  saved /tmp/canopy-${tag}.png`);
  }
}

console.log('\n--- baseline (authored params) ---');
console.log(await readBranchSig());
await shot('1-baseline');

console.log('\n--- degenerate: attractorRadius down to 0.2 (way below segmentLength) ---');
// Drives the trunk into the "no attractor in range" fallback so it just
// extends initialDirection forever. Should be a thin stick with the
// new code, was a uniform rootRadius club with the old code.
await page.evaluate(({ scId }) => {
  window.__sedonStore__.getState().setInputValue(scId, 'attractorRadius', 0.2);
}, { scId: setup.scId });
await new Promise((r) => setTimeout(r, 2000));
console.log(await readBranchSig());
await shot('2-degenerate');

await new Promise((r) => setTimeout(r, 1000));
await browser.close();
await server.stop();
