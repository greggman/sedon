// Dump every position + normal of the final 260? (segments=1 → 68) tri
// mesh that ends up on scene-entity. Plain text, indexed.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));

  const result = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const cache = s.evalCache;
    // Find the mesh with the highest vertex count (compute-normals output).
    let best = null, bestV = 0;
    for (const [fp, outputs] of cache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.normals && v.mesh.positions)) continue;
        const vc = v.mesh.positions.length / 3;
        const tc = v.mesh.indices.length / 3;
        // The compute-normals output has the most verts. For segments=1 it's
        // smaller than 168; for the chamfer case it's ~96 (48 + crease splits).
        if (tc !== 68) continue; // 68 tris == cube chamfer pattern
        if (vc > bestV) {
          bestV = vc;
          best = { fp: fp.slice(0, 10), v, vc, tc };
        }
      }
    }
    if (!best) return { error: 'no 68-tri mesh found' };
    const v = best.v;
    return {
      fp: best.fp,
      verts: best.vc,
      tris: best.tc,
      positions: Array.from(v.mesh.positions).map((x) => +x.toFixed(4)),
      normals: Array.from(v.mesh.normals).map((x) => +x.toFixed(4)),
      indices: Array.from(v.mesh.indices),
    };
  });

  if (result.error) {
    console.log(result.error);
  } else {
    console.log(`fp=${result.fp}  verts=${result.verts}  tris=${result.tris}\n`);
    console.log('# vertices (pos × normal)');
    for (let i = 0; i < result.verts; i++) {
      const px = result.positions[i * 3], py = result.positions[i * 3 + 1], pz = result.positions[i * 3 + 2];
      const nx = result.normals[i * 3], ny = result.normals[i * 3 + 1], nz = result.normals[i * 3 + 2];
      console.log(`v[${i.toString().padStart(3)}]  pos=(${px.toFixed(3).padStart(7)}, ${py.toFixed(3).padStart(7)}, ${pz.toFixed(3).padStart(7)})  n=(${nx.toFixed(3).padStart(6)}, ${ny.toFixed(3).padStart(6)}, ${nz.toFixed(3).padStart(6)})`);
    }
    console.log('\n# triangles');
    for (let t = 0; t < result.tris; t++) {
      console.log(`t[${t.toString().padStart(3)}]  ${result.indices[t * 3]}, ${result.indices[t * 3 + 1]}, ${result.indices[t * 3 + 2]}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
