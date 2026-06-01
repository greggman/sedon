// Read back the GPU position+normal buffers for the bevel mesh on the
// bevel-test scene and compare to the CPU mesh. If they differ, we have
// a buffer upload bug (e.g. reused buffer with stale data).
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => console.log(`[${msg.type()}]`, msg.text()));
try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));

  const result = await page.evaluate(async () => {
    const s = window.__sedonStore__.getState();
    const device = s.device;
    if (!device) return { error: 'no device' };
    // Find the 68-tri 168-vert mesh (final after compute-normals).
    let target = null;
    for (const [fp, outputs] of s.evalCache.entries.entries()) {
      if (!outputs || typeof outputs !== 'object') continue;
      for (const sock of Object.keys(outputs)) {
        const v = outputs[sock];
        if (!(v && v.mesh && v.mesh.indices && v.mesh.indices.length / 3 === 68 && v.mesh.positions.length / 3 === 168)) continue;
        target = { fp: fp.slice(0, 8), v };
      }
    }
    if (!target) return { error: 'no 68-tri 168-vert mesh' };
    const v = target.v;

    // Read back the GPU position buffer.
    const readBuffer = async (gpuBuf, byteSize) => {
      const staging = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(gpuBuf, 0, staging, 0, byteSize);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return data;
    };
    const readBufferU32 = async (gpuBuf, byteSize) => {
      const staging = device.createBuffer({ size: byteSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(gpuBuf, 0, staging, 0, byteSize);
      device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(staging.getMappedRange().slice(0));
      staging.unmap();
      staging.destroy();
      return data;
    };
    const gpuPositions = await readBuffer(v.positionBuffer, v.positionBuffer.size);
    const gpuNormals = await readBuffer(v.normalBuffer, v.normalBuffer.size);
    const gpuIndices = await readBufferU32(v.indexBuffer, v.indexBuffer.size);

    // Compare
    const cpuP = v.mesh.positions, cpuN = v.mesh.normals, cpuI = v.mesh.indices;
    let posDiffs = 0, normDiffs = 0, idxDiffs = 0;
    const firstDiffs = { pos: null, norm: null, idx: null };
    for (let i = 0; i < cpuP.length; i++) {
      if (Math.abs(cpuP[i] - gpuPositions[i]) > 1e-4) {
        posDiffs++;
        if (!firstDiffs.pos) firstDiffs.pos = { i, cpu: cpuP[i], gpu: gpuPositions[i] };
      }
    }
    for (let i = 0; i < cpuN.length; i++) {
      if (Math.abs(cpuN[i] - gpuNormals[i]) > 1e-4) {
        normDiffs++;
        if (!firstDiffs.norm) firstDiffs.norm = { i, cpu: cpuN[i], gpu: gpuNormals[i] };
      }
    }
    for (let i = 0; i < cpuI.length; i++) {
      if (cpuI[i] !== gpuIndices[i]) {
        idxDiffs++;
        if (!firstDiffs.idx) firstDiffs.idx = { i, cpu: cpuI[i], gpu: gpuIndices[i] };
      }
    }
    return {
      fp: target.fp,
      gpuBuf: { pos: gpuPositions.length, norm: gpuNormals.length, idx: gpuIndices.length },
      cpuBuf: { pos: cpuP.length, norm: cpuN.length, idx: cpuI.length },
      diffs: { pos: posDiffs, norm: normDiffs, idx: idxDiffs },
      firstDiffs,
      gpuFirst8Pos: Array.from(gpuPositions.slice(0, 24)).map((x) => +x.toFixed(3)),
      cpuFirst8Pos: Array.from(cpuP.slice(0, 24)).map((x) => +x.toFixed(3)),
      gpuFirst8Norm: Array.from(gpuNormals.slice(0, 24)).map((x) => +x.toFixed(3)),
      cpuFirst8Norm: Array.from(cpuN.slice(0, 24)).map((x) => +x.toFixed(3)),
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  server.stop();
}
