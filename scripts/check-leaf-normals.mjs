// Dump the (position, normal) for the first 20 leaf points on one
// branch. If phi randomization is working, the normals should fan
// radially around the branch tangent. If they all point the same
// direction, that's the "bottle brush" bug.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 4000));

const ids = await page.evaluate(() => {
  const subs = window.__sedonStore__.getState().subgraphs;
  const canopy = subs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
  const sample = canopy.graph.nodes.find((n) => n.kind === 'branch/sample-points');
  return { canopyId: canopy.id, sampleId: sample.id };
});

await page.evaluate((cid) => window.__sedonOpenGraphInCanvas__(cid, 'canvas-main'), ids.canopyId);
await new Promise((r) => setTimeout(r, 2000));

const dump = await page.evaluate(({ sampleId }) => {
  const out = window.__sedonGetOutputs__('canvas-main', sampleId);
  const pts = out?.points;
  if (!pts) return { err: 'no points' };

  // Take a contiguous range of points — likely all from the same branch
  // (sample-points emits per-branch in order).
  const N = Math.min(20, pts.count);
  const data = [];
  for (let i = 0; i < N; i++) {
    data.push({
      pos: [+pts.positions[i*3].toFixed(3), +pts.positions[i*3+1].toFixed(3), +pts.positions[i*3+2].toFixed(3)],
      n:   [+pts.normals[i*3].toFixed(3),   +pts.normals[i*3+1].toFixed(3),   +pts.normals[i*3+2].toFixed(3)],
    });
  }
  return { count: pts.count, first20: data, hasTangents: !!pts.tangents };
}, ids);

console.log(JSON.stringify(dump, null, 2));

await browser.close();
await server.stop();
