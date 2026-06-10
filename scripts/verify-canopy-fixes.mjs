// End-to-end smoke test for the three space-colonization-related fixes:
//
//   1. Thick-trunk taper: render the authored canopy subgraph and a
//      degenerate (1-branch) variant. Both should show a continuous
//      taper rootRadius → tipRadius, not a uniform club.
//   2. Preview-of-main updates on subgraph edits: keep the preview on
//      "main", edit a canopy parameter, confirm the rendered scene's
//      canopy tree visibly changes.
//   3. New distribute-in-volume node exists: load the docs page and
//      confirm the sample renders.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});

async function biggestCanvasShot(page, path) {
  const handle = await page.evaluateHandle(() => {
    let best = null;
    for (const c of document.querySelectorAll('canvas')) {
      const area = c.clientWidth * c.clientHeight;
      if (!best || area > best.area) best = { el: c, area };
    }
    return best?.el ?? null;
  });
  const el = handle.asElement();
  if (el) {
    await el.screenshot({ path });
    return true;
  }
  return false;
}

// --- (3) distribute-in-volume docs page ---
{
  const page = await browser.newPage();
  await page.goto(`${server.url}docs/nodes/points/in-volume/`,
    { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: '/tmp/distribute-in-volume-docs.png', fullPage: false });
  console.log('saved /tmp/distribute-in-volume-docs.png');
  await page.close();
}

// --- (1, 2) Live editor: tree-bush, preview-on-main, edit canopy ---
{
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 4000));

  // Baseline render with preview on main, no edits.
  await biggestCanvasShot(page, '/tmp/canopy-fix-1-main-before.png');
  console.log('saved /tmp/canopy-fix-1-main-before.png  (main, before edit)');

  // Now switch the CANVAS to edit Branch Canopy. Preview stays on main.
  const ids = await page.evaluate(() => {
    const subs = window.__sedonStore__.getState().subgraphs;
    const canopy = subs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
    const sc = canopy.graph.nodes.find((n) => n.kind === 'branch/space-colonization');
    return { canopyId: canopy.id, scId: sc.id };
  });
  await page.evaluate((cid) => window.__sedonOpenGraphInCanvas__(cid, 'canvas-main'),
    ids.canopyId);
  await new Promise((r) => setTimeout(r, 2000));

  // Make a visible change to the canopy: bump rootRadius to 1.0
  // (way thicker). With the preview-deps fix, the main preview should
  // re-eval and the canopy tree on main should show a thicker trunk.
  await page.evaluate(({ scId }) => {
    window.__sedonStore__.getState().setInputValue(scId, 'rootRadius', 1.0);
  }, ids);
  await new Promise((r) => setTimeout(r, 3000));

  await biggestCanvasShot(page, '/tmp/canopy-fix-2-main-after-rootRadius.png');
  console.log('saved /tmp/canopy-fix-2-main-after-rootRadius.png  (main, after rootRadius=1.0 in subgraph)');

  // (1) Degenerate canopy: small attractorRadius. Tree becomes a stick.
  // Restore rootRadius and force degenerate.
  await page.evaluate(({ scId }) => {
    const set = window.__sedonStore__.getState().setInputValue;
    set(scId, 'rootRadius', 0.35);
    set(scId, 'attractorRadius', 0.2);
  }, ids);
  await new Promise((r) => setTimeout(r, 3000));

  await biggestCanvasShot(page, '/tmp/canopy-fix-3-degenerate-stick.png');
  console.log('saved /tmp/canopy-fix-3-degenerate-stick.png  (degenerate stick — should taper, not club)');

  await page.close();
}

await browser.close();
await server.stop();
