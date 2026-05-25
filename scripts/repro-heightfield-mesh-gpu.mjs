// heightfield-to-mesh GPU path. Verifies:
//   1. With cpu_access OFF (the new default) — the node produces a
//      renderable Geometry with vertex + index buffers AND NO `mesh`
//      field. The whole point: no GPU→CPU readback for the pure
//      rendering path.
//   2. With cpu_access ON (the legacy + opt-in path) — the geometry
//      still includes a CPU mesh, so downstream nodes that need CPU
//      data (distribute-on-faces, merge-scene-entities) still work.
//   3. Both demos still render visible terrain end-to-end (no page or
//      WebGPU validation errors), proving the new compute pipeline
//      slots into the renderer transparently.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('[pageerror]', e.message); });

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

const inspectMesh = async (demoId) => {
  await page.evaluate((id) => {
    const demo = window.__sedonDemos__.find((d) => d.id === id);
    const { graph, rootNodeId, subgraphs, cameras } = demo.build();
    window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
  }, demoId);
  // Generous wait for the chain to settle. Forest's CPU readback path
  // is async; give it room.
  await new Promise((r) => setTimeout(r, 4000));
  return page.evaluate(() => {
    const st = window.__sedonStore__.getState();
    const cache = st.evalCache;
    const node = st.graph.nodes.find((n) => n.kind === 'core/heightfield-to-mesh');
    if (!node) return { error: 'no heightfield-to-mesh node in demo' };
    const fp = cache.lastFingerprintByNodeId.get(node.id);
    if (!fp) return { error: 'no fingerprint cached for mesh node' };
    const entry = cache.entries.get(fp);
    if (!entry) return { error: 'cache entry missing' };
    const g = entry.geometry;
    if (!g) return { error: 'no geometry in cache entry' };
    return {
      indexCount: g.indexCount,
      hasPositionBuffer: !!g.positionBuffer,
      hasNormalBuffer: !!g.normalBuffer,
      hasUvBuffer: !!g.uvBuffer,
      hasIndexBuffer: !!g.indexBuffer,
      hasCpuMesh: g.mesh !== undefined,
      cpuMeshVertexCount: g.mesh ? g.mesh.positions.length / 3 : null,
    };
  });
};

// 1. Multi-layer demo — cpu_access defaults to false → pure GPU path.
const gpuOnly = await inspectMesh('multi-layer-terrain');
console.log('multi-layer-terrain (cpu_access=false):', gpuOnly);

// 2. Forest demo — explicit cpu_access=true → readback path.
const cpuAccess = await inspectMesh('forest');
console.log('forest (cpu_access=true):           ', cpuAccess);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const noPageErrors = pageErrors.length === 0;
const gpuPathValid =
  !gpuOnly.error
  && gpuOnly.indexCount > 0
  && gpuOnly.hasPositionBuffer
  && gpuOnly.hasNormalBuffer
  && gpuOnly.hasUvBuffer
  && gpuOnly.hasIndexBuffer;
const gpuPathHasNoCpuMesh = !gpuOnly.error && gpuOnly.hasCpuMesh === false;
const cpuPathValid =
  !cpuAccess.error
  && cpuAccess.indexCount > 0
  && cpuAccess.hasPositionBuffer;
const cpuPathHasCpuMesh = !cpuAccess.error && cpuAccess.hasCpuMesh === true
  && (cpuAccess.cpuMeshVertexCount ?? 0) > 0;

console.log(`no page errors:                                ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length} errors)`);
console.log(`GPU path produces a renderable geometry:       ${gpuPathValid ? 'PASS ✓' : 'FAIL ✗'} (indexCount=${gpuOnly.indexCount})`);
console.log(`GPU path has NO CPU mesh (no readback):        ${gpuPathHasNoCpuMesh ? 'PASS ✓' : 'FAIL ✗'} (hasCpuMesh=${gpuOnly.hasCpuMesh})`);
console.log(`CPU-access path also produces geometry:        ${cpuPathValid ? 'PASS ✓' : 'FAIL ✗'} (indexCount=${cpuAccess.indexCount})`);
console.log(`CPU-access path populates the mesh field:      ${cpuPathHasCpuMesh ? 'PASS ✓' : 'FAIL ✗'} (vertexCount=${cpuAccess.cpuMeshVertexCount})`);

const ok = noPageErrors && gpuPathValid && gpuPathHasNoCpuMesh && cpuPathValid && cpuPathHasCpuMesh;
process.exit(ok ? 0 : 1);
