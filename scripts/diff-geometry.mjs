// Deep-compare the GeometryValue produced by geom/cube vs the one produced
// by the bevel-test subgraph (geom/bevel → geom/compute-normals). Goal:
// find any property the cube sets that the bevel chain forgets to set
// (or sets to a value that breaks shaded rendering).
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

    // Probe a GeometryValue: report top-level keys, shape of the embedded
    // mesh, and any GPU resource markers (so we can compare).
    const describe = (v) => {
      if (!v || typeof v !== 'object') return { kind: typeof v };
      const keys = Object.keys(v);
      const out = { keys, types: {} };
      for (const k of keys) {
        const x = v[k];
        if (x == null) { out.types[k] = String(x); continue; }
        if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') {
          out.types[k] = `${typeof x}:${x}`;
        } else if (Array.isArray(x)) {
          out.types[k] = `Array(${x.length})`;
        } else if (ArrayBuffer.isView(x)) {
          out.types[k] = `${x.constructor.name}(${x.length})`;
        } else if (x instanceof Map) {
          out.types[k] = `Map(${x.size})`;
        } else if (typeof x === 'object') {
          // Note construction name + own keys for one level
          const cname = x.constructor?.name ?? 'object';
          if (cname === 'Object') {
            out.types[k] = `Object{${Object.keys(x).join(',')}}`;
          } else if (cname === 'GPUBuffer') {
            out.types[k] = `GPUBuffer(size=${x.size})`;
          } else {
            out.types[k] = cname;
          }
        } else {
          out.types[k] = typeof x;
        }
      }
      return out;
    };

    // Find: one geometry value from a geom/cube node, one from a geom/bevel
    // chain. We have to look at the graph for node kinds, then the cache
    // entries for the corresponding outputs.
    //
    // Easier: just dump EVERY GeometryValue with its tri count, and the user
    // can identify which is which.
    const geos = [];
    for (const [fp, outputs] of cache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.positions && v.indexBuffer)) continue;
        geos.push({
          fp: fp.slice(0, 8),
          sock,
          tris: v.mesh.indices.length / 3,
          desc: describe(v),
          meshDesc: describe(v.mesh),
        });
      }
    }
    // Also, an in-process produced plain cube for direct comparison:
    // we can build a fresh geom/cube via the graph's evaluator? Simpler:
    // just report what's there.
    return { geos };
  });

  // Group geos: one with tris=12 is the cube primitive; tris=68 is bevel
  // (segments=1). Show the diff.
  const cubes = result.geos.filter((g) => g.tris === 12);
  const bevels = result.geos.filter((g) => g.tris === 68);
  console.log(`found ${cubes.length} cube-shaped geometries, ${bevels.length} bevel-shaped`);
  if (cubes.length === 0 || bevels.length === 0) {
    console.log('all geometries:', result.geos.map((g) => ({ fp: g.fp, tris: g.tris })));
    process.exit(0);
  }

  const cube = cubes[0];
  const bevel = bevels[bevels.length - 1]; // latest bevel (after compute-normals)
  console.log('\n=== CUBE ===');
  console.log('GeometryValue keys:', cube.desc.keys);
  console.log('Types:', JSON.stringify(cube.desc.types, null, 2));
  console.log('Mesh keys:', cube.meshDesc.keys);
  console.log('Mesh types:', JSON.stringify(cube.meshDesc.types, null, 2));
  console.log('\n=== BEVEL ===');
  console.log('GeometryValue keys:', bevel.desc.keys);
  console.log('Types:', JSON.stringify(bevel.desc.types, null, 2));
  console.log('Mesh keys:', bevel.meshDesc.keys);
  console.log('Mesh types:', JSON.stringify(bevel.meshDesc.types, null, 2));

  // Diff
  const cubeKeys = new Set(cube.desc.keys), bevelKeys = new Set(bevel.desc.keys);
  console.log('\n=== DIFF (top-level GeometryValue) ===');
  for (const k of cubeKeys) if (!bevelKeys.has(k)) console.log(`  only on CUBE:  ${k}`);
  for (const k of bevelKeys) if (!cubeKeys.has(k)) console.log(`  only on BEVEL: ${k}`);
  for (const k of cubeKeys) {
    if (!bevelKeys.has(k)) continue;
    if (cube.desc.types[k] !== bevel.desc.types[k]) {
      console.log(`  differs in ${k}:  cube=${cube.desc.types[k]}  bevel=${bevel.desc.types[k]}`);
    }
  }
  const cubeMeshKeys = new Set(cube.meshDesc.keys), bevelMeshKeys = new Set(bevel.meshDesc.keys);
  console.log('\n=== DIFF (mesh) ===');
  for (const k of cubeMeshKeys) if (!bevelMeshKeys.has(k)) console.log(`  only on CUBE:  ${k}`);
  for (const k of bevelMeshKeys) if (!cubeMeshKeys.has(k)) console.log(`  only on BEVEL: ${k}`);
  for (const k of cubeMeshKeys) {
    if (!bevelMeshKeys.has(k)) continue;
    if (cube.meshDesc.types[k] !== bevel.meshDesc.types[k]) {
      console.log(`  differs in ${k}:  cube=${cube.meshDesc.types[k]}  bevel=${bevel.meshDesc.types[k]}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
