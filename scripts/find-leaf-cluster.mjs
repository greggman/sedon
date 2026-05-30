// Find dense clusters of leaves — voxelise the leaf cloud and report
// the cells with the most leaves. If hundreds land in one cell, we've
// got an algorithm bug, not a tuning issue.

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
  if (!pts || !bg) return { err: 'missing' };

  // Voxelise into 0.1 m cubes. Report the densest cells.
  const cells = new Map();
  for (let k = 0; k < pts.count; k++) {
    const x = Math.floor(pts.positions[k*3]   / 0.1);
    const y = Math.floor(pts.positions[k*3+1] / 0.1);
    const z = Math.floor(pts.positions[k*3+2] / 0.1);
    const key = `${x},${y},${z}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const top = [...cells.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // For the densest cell, find which branch's polyline passes
  // closest to it.
  const [topKey, topCount] = top[0];
  const [cx, cy, cz] = topKey.split(',').map(Number);
  const worldX = (cx + 0.5) * 0.1;
  const worldY = (cy + 0.5) * 0.1;
  const worldZ = (cz + 0.5) * 0.1;

  function distSqToSeg(ax, ay, az, bx, by, bz, px, py, pz) {
    const ex = bx-ax, ey = by-ay, ez = bz-az;
    const len2 = ex*ex + ey*ey + ez*ez;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((px-ax)*ex + (py-ay)*ey + (pz-az)*ez) / len2;
      if (t < 0) t = 0; if (t > 1) t = 1;
    }
    const dx = px - (ax + ex*t), dy = py - (ay + ey*t), dz = pz - (az + ez*t);
    return dx*dx + dy*dy + dz*dz;
  }

  let nearestBranch = -1, nearestSeg = -1, nearestD = Infinity;
  for (let b = 0; b < bg.branchCount; b++) {
    const vs = bg.vertexStart[b];
    const vc = bg.vertexLength[b];
    for (let i = 0; i < vc - 1; i++) {
      const ax = bg.positions[(vs+i)*3], ay = bg.positions[(vs+i)*3+1], az = bg.positions[(vs+i)*3+2];
      const bxv = bg.positions[(vs+i+1)*3], byv = bg.positions[(vs+i+1)*3+1], bzv = bg.positions[(vs+i+1)*3+2];
      const d = distSqToSeg(ax, ay, az, bxv, byv, bzv, worldX, worldY, worldZ);
      if (d < nearestD) { nearestD = d; nearestBranch = b; nearestSeg = i; }
    }
  }

  // Dump the suspect segment's details.
  const vs = bg.vertexStart[nearestBranch];
  const vc = bg.vertexLength[nearestBranch];
  const segs = [];
  for (let i = 0; i < vc - 1; i++) {
    const ax = bg.positions[(vs+i)*3], ay = bg.positions[(vs+i)*3+1], az = bg.positions[(vs+i)*3+2];
    const bxv = bg.positions[(vs+i+1)*3], byv = bg.positions[(vs+i+1)*3+1], bzv = bg.positions[(vs+i+1)*3+2];
    const arc0 = bg.arcLength[vs+i], arc1 = bg.arcLength[vs+i+1];
    segs.push({
      i,
      r0: +bg.radii[vs+i].toFixed(3),
      r1: +bg.radii[vs+i+1].toFixed(3),
      arc0: +arc0.toFixed(3),
      arc1: +arc1.toFixed(3),
      segLen: +(arc1 - arc0).toFixed(3),
      euclid: +Math.hypot(bxv-ax, byv-ay, bzv-az).toFixed(3),
    });
  }

  // How many DISTINCT branch segments pass within 0.2 m of the densest cell?
  let nearBranches = 0;
  const branchesNear = [];
  for (let b = 0; b < bg.branchCount; b++) {
    const vs = bg.vertexStart[b];
    const vc = bg.vertexLength[b];
    let minD = Infinity;
    for (let i = 0; i < vc - 1; i++) {
      const ax = bg.positions[(vs+i)*3], ay = bg.positions[(vs+i)*3+1], az = bg.positions[(vs+i)*3+2];
      const bxv = bg.positions[(vs+i+1)*3], byv = bg.positions[(vs+i+1)*3+1], bzv = bg.positions[(vs+i+1)*3+2];
      const d = distSqToSeg(ax, ay, az, bxv, byv, bzv, worldX, worldY, worldZ);
      if (d < minD) minD = d;
    }
    if (Math.sqrt(minD) < 0.2) {
      nearBranches++;
      branchesNear.push({ branch: b, depth: bg.branchDepth[b], vc, dist: +Math.sqrt(minD).toFixed(3) });
    }
  }

  return {
    totalLeaves: pts.count,
    branchCount: bg.branchCount,
    topCells: top.map(([k, n]) => ({ cell: k, leaves: n })),
    densestCellCenter: [+worldX.toFixed(2), +worldY.toFixed(2), +worldZ.toFixed(2)],
    branchesWithin_0_2m: nearBranches,
    branchesNear: branchesNear.slice(0, 10),
  };
}, ids);

console.log(JSON.stringify(dump, null, 2));

await browser.close();
await server.stop();
