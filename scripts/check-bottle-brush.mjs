// Investigate the "one branch has 100s of leaves" report. For each
// BranchGraph branch in the canopy subgraph, print:
//   - vertex count, arc length
//   - radii (min/median/max)
//   - estimated leaves it contributes (segments whose mean radius
//     passes the leaf-sample radiusMax filter, × density × seg length)
//   - actual leaf count by mapping leaf points back to their branch
//
// Spots the outlier branch and shows why it gets so many leaves.

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

await page.goto(`${server.url}?debug=1&scene=tree-bush`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 4000));

const ids = await page.evaluate(() => {
  const subs = window.__sedonStore__.getState().subgraphs;
  const canopy = subs.find((s) => /branch.?canopy/i.test(s.name ?? s.id));
  // Find sample-points (leaf source) AND its upstream tropism/sc that produced the BranchGraph
  const sample = canopy.graph.nodes.find((n) => n.kind === 'branch/sample-points');
  // Trace back to whatever the BranchGraph input is.
  const edge = canopy.graph.edges.find((e) => e.to.node === sample.id && e.to.socket === 'branches');
  const upstreamId = edge?.from.node;
  return { canopyId: canopy.id, sampleId: sample.id, upstreamId };
});
console.log('ids:', ids);

await page.evaluate((cid) => window.__sedonOpenGraphInCanvas__(cid, 'canvas-main'), ids.canopyId);
await new Promise((r) => setTimeout(r, 2000));

const dump = await page.evaluate(({ sampleId, upstreamId }) => {
  const bgOut = window.__sedonGetOutputs__('canvas-main', upstreamId);
  const sampleOut = window.__sedonGetOutputs__('canvas-main', sampleId);
  if (!bgOut?.branches) return { err: 'no branches' };
  const bg = bgOut.branches;
  const pts = sampleOut?.points;

  const RADIUS_MAX = 0.06;
  const DENSITY = 50;
  const branches = [];
  for (let b = 0; b < bg.branchCount; b++) {
    const vs = bg.vertexStart[b];
    const vc = bg.vertexLength[b];
    const radii = [];
    for (let i = 0; i < vc; i++) radii.push(bg.radii[vs + i]);
    radii.sort((a, b) => a - b);

    // Match the actual sample-points filter (depth >= 1, radius window).
    let estLeaves = 0;
    let leafyArcLen = 0;
    if (bg.branchDepth[b] >= 1) {
      for (let i = 0; i < vc - 1; i++) {
        const r0 = bg.radii[vs + i];
        const r1 = bg.radii[vs + i + 1];
        const rAvg = (r0 + r1) / 2;
        if (rAvg > RADIUS_MAX) continue;
        const segLen = bg.arcLength[vs + i + 1] - bg.arcLength[vs + i];
        estLeaves += segLen * DENSITY;
        leafyArcLen += segLen;
      }
    }

    branches.push({
      idx: b,
      depth: bg.branchDepth[b],
      vc,
      arcLen: +bg.arcLength[vs + vc - 1].toFixed(2),
      leafyArc: +leafyArcLen.toFixed(2),
      rMin: +radii[0].toFixed(3),
      rMed: +radii[Math.floor(radii.length / 2)].toFixed(3),
      rMax: +radii[radii.length - 1].toFixed(3),
      estLeaves: Math.round(estLeaves),
    });
  }
  const sumEst = branches.reduce((s, b) => s + b.estLeaves, 0);
  branches.sort((a, b) => b.estLeaves - a.estLeaves);

  // For each leaf, find the nearest SEGMENT across all branches and
  // attribute it to the owning branch.
  let actualPerBranch = [];
  if (pts) {
    const counts = new Int32Array(bg.branchCount);
    function distSq(ax, ay, az, bx, by, bz, px, py, pz) {
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const len2 = ex*ex + ey*ey + ez*ez;
      let t = 0;
      if (len2 > 1e-12) {
        t = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2;
        if (t < 0) t = 0; if (t > 1) t = 1;
      }
      const cx = ax + ex * t, cy = ay + ey * t, cz = az + ez * t;
      const dx = px - cx, dy = py - cy, dz = pz - cz;
      return dx*dx + dy*dy + dz*dz;
    }
    for (let k = 0; k < pts.count; k++) {
      const px = pts.positions[k * 3];
      const py = pts.positions[k * 3 + 1];
      const pz = pts.positions[k * 3 + 2];
      let bestB = -1;
      let bestD = Infinity;
      for (let b = 0; b < bg.branchCount; b++) {
        const vs = bg.vertexStart[b];
        const vc = bg.vertexLength[b];
        for (let i = 0; i < vc - 1; i++) {
          const ax = bg.positions[(vs + i) * 3];
          const ay = bg.positions[(vs + i) * 3 + 1];
          const az = bg.positions[(vs + i) * 3 + 2];
          const bxv = bg.positions[(vs + i + 1) * 3];
          const byv = bg.positions[(vs + i + 1) * 3 + 1];
          const bzv = bg.positions[(vs + i + 1) * 3 + 2];
          const d = distSq(ax, ay, az, bxv, byv, bzv, px, py, pz);
          if (d < bestD) { bestD = d; bestB = b; }
        }
      }
      if (bestB >= 0) counts[bestB]++;
    }
    actualPerBranch = Array.from(counts).map((c, i) => ({ branch: i, leaves: c }));
    actualPerBranch.sort((a, b) => b.leaves - a.leaves);
  }

  return {
    branchCount: bg.branchCount,
    totalLeafPoints: pts?.count ?? null,
    sumEstimatedLeaves: sumEst,
    shortBranchCount: branches.filter((b) => b.arcLen < 0.5 && b.depth >= 1 && b.leafyArc > 0).length,
    top10ByEstimate: branches.slice(0, 5),
    top10Actual: actualPerBranch.slice(0, 10),
    actualWithDetails: actualPerBranch.slice(0, 5).map((x) => {
      const b = branches.find((br) => br.idx === x.branch);
      return { ...x, ...b };
    }),
  };
}, ids);

console.log(JSON.stringify(dump, null, 2));

await browser.close();
await server.stop();
