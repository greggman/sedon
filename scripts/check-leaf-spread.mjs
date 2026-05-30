// For the top-leaf-count branch, dump ALL its leaf positions+normals.
// Look at whether (a) leaves are clumped at a few phi values, or
// (b) they're spread across phi but their world positions barely
// differ because the branch is so thin.

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
  const edge = canopy.graph.edges.find((e) => e.to.node === sample.id && e.to.socket === 'branches');
  return { canopyId: canopy.id, sampleId: sample.id, bgId: edge.from.node };
});
await page.evaluate((cid) => window.__sedonOpenGraphInCanvas__(cid, 'canvas-main'), ids.canopyId);
await new Promise((r) => setTimeout(r, 2000));

const dump = await page.evaluate(({ sampleId, bgId }) => {
  const pts = window.__sedonGetOutputs__('canvas-main', sampleId)?.points;
  const bg = window.__sedonGetOutputs__('canvas-main', bgId)?.branches;

  // Find first branch with depth=4 and arcLen=0.4 (a typical short tip)
  let targetBranch = -1;
  for (let b = 0; b < bg.branchCount; b++) {
    const vs = bg.vertexStart[b];
    const vc = bg.vertexLength[b];
    const arc = bg.arcLength[vs + vc - 1];
    if (bg.branchDepth[b] >= 1 && vc === 2 && arc < 0.5) {
      targetBranch = b;
      break;
    }
  }
  if (targetBranch < 0) return { err: 'no target branch' };

  const vs = bg.vertexStart[targetBranch];
  const vc = bg.vertexLength[targetBranch];
  const ax = bg.positions[vs * 3];
  const ay = bg.positions[vs * 3 + 1];
  const az = bg.positions[vs * 3 + 2];
  const bxv = bg.positions[(vs + 1) * 3];
  const byv = bg.positions[(vs + 1) * 3 + 1];
  const bzv = bg.positions[(vs + 1) * 3 + 2];

  // Find leaves close to this branch's segment
  function distToSeg(px, py, pz) {
    const ex = bxv - ax, ey = byv - ay, ez = bzv - az;
    const len2 = ex*ex + ey*ey + ez*ez;
    let t = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2;
    if (t < 0) t = 0; if (t > 1) t = 1;
    const cx = ax + ex*t, cy = ay + ey*t, cz = az + ez*t;
    return [
      Math.hypot(px - cx, py - cy, pz - cz),
      t,
    ];
  }

  const closeLeaves = [];
  for (let k = 0; k < pts.count; k++) {
    const px = pts.positions[k * 3];
    const py = pts.positions[k * 3 + 1];
    const pz = pts.positions[k * 3 + 2];
    const [d, t] = distToSeg(px, py, pz);
    if (d < 0.05) {
      closeLeaves.push({
        d: +d.toFixed(3),
        t: +t.toFixed(2),
        pos: [+px.toFixed(3), +py.toFixed(3), +pz.toFixed(3)],
        n: [+pts.normals[k*3].toFixed(2), +pts.normals[k*3+1].toFixed(2), +pts.normals[k*3+2].toFixed(2)],
      });
    }
  }
  return {
    targetBranch,
    branchSeg: { a: [ax, ay, az], b: [bxv, byv, bzv], arc: bg.arcLength[vs+1], r0: bg.radii[vs], r1: bg.radii[vs+1] },
    closeLeavesCount: closeLeaves.length,
    closeLeaves: closeLeaves.slice(0, 30),
  };
}, ids);

console.log(JSON.stringify(dump, null, 2));

await browser.close();
await server.stop();
