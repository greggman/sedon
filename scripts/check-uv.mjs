// Check the bevel mesh for index-buffer issues. An index >= vertexCount
// will sample uninitialized GPU memory for that vertex's normal/uv/pos,
// which on some drivers reads as zero → black.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));

  const result = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const out = [];
    for (const [fp, outputs] of s.evalCache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.indices && v.mesh.positions)) continue;
        if (v.mesh.indices.length / 3 !== 68) continue;
        const indices = v.mesh.indices;
        const vc = v.mesh.positions.length / 3;
        let maxIdx = -1, minIdx = Infinity, bad = 0;
        const badList = [];
        for (let i = 0; i < indices.length; i++) {
          const ix = indices[i];
          if (ix < minIdx) minIdx = ix;
          if (ix > maxIdx) maxIdx = ix;
          if (ix < 0 || ix >= vc) { bad++; if (badList.length < 10) badList.push({ i, ix }); }
        }
        // Also: indexBuffer.size should equal indices.length * 4 (uint32).
        out.push({
          fp: fp.slice(0, 8),
          verts: vc,
          tris: v.mesh.indices.length / 3,
          minIdx, maxIdx,
          badIndices: bad,
          badList,
          indexBufferSize: v.indexBuffer?.size,
          indexCount: v.indexCount,
          expectedIndexBufferBytes: indices.length * 4,
          expectedIndexCount: indices.length,
        });
      }
    }
    return out;
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.stop();
}
