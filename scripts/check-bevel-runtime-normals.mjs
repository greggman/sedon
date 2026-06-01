// Inspect position bounds + sample positions for the final mesh.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('[console]', msg.text()); });

try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));

  const result = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    const cache = s.evalCache;
    const found = [];
    for (const [fp, outputs] of cache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.normals && v.mesh.positions)) continue;
        const positions = v.mesh.positions;
        const vCount = positions.length / 3;
        const triCount = v.mesh.indices.length / 3;
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        let nans = 0;
        for (let i = 0; i < vCount; i++) {
          const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
          if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) { nans++; continue; }
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        found.push({
          fp: fp.slice(0, 12),
          verts: vCount,
          tris: triCount,
          nans,
          bbox: { min: [minX, minY, minZ].map((v) => +v.toFixed(3)), max: [maxX, maxY, maxZ].map((v) => +v.toFixed(3)) },
        });
      }
    }
    // Also check material + entity for cached values, scene fingerprint
    return { found };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.stop();
}
