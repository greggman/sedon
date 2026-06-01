// Dump the bevel and compute-normals meshes (positions, normals, UVs,
// indices) from the live bevel-test scene to JSON + OBJ files so they
// can be loaded into an external renderer to compare/verify.
//
// Both stages have the SAME triangle count (compute-normals only splits
// vertices at creases, never modifies topology). We disambiguate by
// vertex count: bevel raw output has fewer verts (placeholder normals,
// no crease splits); compute-normals output has more (split at every
// crease edge that hits the cusp threshold).
//
// Outputs:
//   /tmp/bevel-mesh.{json,obj}             — raw bevel output
//   /tmp/compute-normals-mesh.{json,obj}   — after compute-normals
import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';
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
    // Collect every mesh that matches the bevel/compute-normals tri
    // count range; we'll group by vertex count and pick the
    // bevel-raw (fewer verts) vs compute-normals (more verts) cases.
    const all = [];
    for (const [fp, outputs] of s.evalCache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.indices)) continue;
        const tc = v.mesh.indices.length / 3;
        if (tc < 30 || tc > 500) continue;
        all.push({
          fp: fp.slice(0, 12),
          vertexCount: v.mesh.positions.length / 3,
          triangleCount: tc,
          positions: Array.from(v.mesh.positions),
          normals: Array.from(v.mesh.normals),
          uvs: Array.from(v.mesh.uvs),
          indices: Array.from(v.mesh.indices),
        });
      }
    }
    return all;
  });

  if (result.length === 0) {
    console.log('no bevel/normals meshes found in cache');
    process.exit(1);
  }

  // Sort by vertex count ascending. Smallest = bevel raw output.
  // Largest = compute-normals output (crease splits added verts).
  result.sort((a, b) => a.vertexCount - b.vertexCount);
  const bevelRaw = result[0];
  const computeNormals = result[result.length - 1];

  function writeMeshFiles(mesh, baseName) {
    writeFileSync(`/tmp/${baseName}.json`, JSON.stringify(mesh, null, 2));
    let obj = `# ${baseName} — ${mesh.vertexCount} verts, ${mesh.triangleCount} tris (fp=${mesh.fp})\n`;
    for (let i = 0; i < mesh.vertexCount; i++) {
      obj += `v ${mesh.positions[i*3]} ${mesh.positions[i*3+1]} ${mesh.positions[i*3+2]}\n`;
    }
    for (let i = 0; i < mesh.vertexCount; i++) {
      obj += `vt ${mesh.uvs[i*2]} ${mesh.uvs[i*2+1]}\n`;
    }
    for (let i = 0; i < mesh.vertexCount; i++) {
      obj += `vn ${mesh.normals[i*3]} ${mesh.normals[i*3+1]} ${mesh.normals[i*3+2]}\n`;
    }
    for (let t = 0; t < mesh.triangleCount; t++) {
      const a = mesh.indices[t*3] + 1, b = mesh.indices[t*3+1] + 1, c = mesh.indices[t*3+2] + 1;
      obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
    }
    writeFileSync(`/tmp/${baseName}.obj`, obj);
    console.log(`→ /tmp/${baseName}.{json,obj}  (${mesh.vertexCount} verts, ${mesh.triangleCount} tris, fp=${mesh.fp})`);
  }

  writeMeshFiles(bevelRaw, 'bevel-mesh');
  if (computeNormals !== bevelRaw) {
    writeMeshFiles(computeNormals, 'compute-normals-mesh');
  } else {
    console.log('(only one mesh in the bevel/normals tri-count range — no compute-normals downstream in the chain?)');
  }
} finally {
  await browser.close();
  server.stop();
}
