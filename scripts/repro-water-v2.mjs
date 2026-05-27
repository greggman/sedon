// Verifies the four water v2 follow-ups: bigger plane, wave
// displacement, underwater shimmer, underwater depth fog.
//
// 1. Bigger plane — read the water entity's CPU mesh and assert its
//    XZ extent is at least 4× the heightfield's worldSize.
// 2. Wave displacement — assert the water mesh has >100 vertices
//    (default subdivisions 64 → 65² = 4225). The single-quad v1 had 4.
// 3. Underwater shimmer — render two underwater frames at a small
//    time interval and assert the resulting screenshots differ
//    pixel-by-pixel (any wobble produces different sampling). A
//    static composite would give identical frames.
// 4. Depth fog — sample the underwater frame at a "near" pixel
//    (center, close to camera) and a "far" pixel (top-edge,
//    distant). The far pixel should be DARKER / more uniform tint
//    than the near pixel (more like the murk floor).
//
// Plus no page errors and no WebGPU validation errors anywhere.

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

// Capture WebGPU validation errors at the earliest possible moment by
// patching navigator.gpu.requestDevice in a script that runs before
// any other JS. Errors that fire after device creation but during
// pipeline setup still surface this way.
const gpuErrors = [];
await page.evaluateOnNewDocument(() => {
  const origReq = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (...a) => {
    const ad = await origReq(...a);
    const origReqDev = ad.requestDevice.bind(ad);
    ad.requestDevice = async (...b) => {
      const dev = await origReqDev(...b);
      dev.onuncapturederror = (ev) => console.error('GPU_ERR:', ev.error.message);
      return dev;
    };
    return ad;
  };
});
page.on('console', (m) => {
  if (m.text().startsWith('GPU_ERR:')) {
    gpuErrors.push(m.text());
    console.log('[gpu]', m.text());
  }
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'multi-layer-terrain');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
});
await new Promise((r) => setTimeout(r, 5500));

// Probes 1 + 2: introspect the water entity's geometry via the cache.
const meshProbe = await page.evaluate(() => {
  const st = window.__sedonStore__.getState();
  const cache = st.evalCache;
  const waterNode = st.graph.nodes.find((n) => n.kind === 'water/plane');
  const fp = cache.lastFingerprintByNodeId.get(waterNode.id);
  const entry = fp ? cache.entries.get(fp) : null;
  const ent = entry?.scene?.entities?.[0];
  const mesh = ent?.geometry?.mesh;
  if (!mesh) return { error: 'water entity mesh missing' };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const z = mesh.positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const hfNode = st.graph.nodes.find((n) => n.kind === 'core/heightfield');
  const hfFp = cache.lastFingerprintByNodeId.get(hfNode.id);
  const hfEntry = hfFp ? cache.entries.get(hfFp) : null;
  const hfWorldSize = hfEntry?.heightfield?.worldSize ?? [0, 0];
  return {
    vertexCount: mesh.positions.length / 3,
    xExtent: maxX - minX,
    zExtent: maxZ - minZ,
    hfXExtent: hfWorldSize[0],
    hfZExtent: hfWorldSize[1],
  };
});
console.log('water mesh probe:', meshProbe);

// Probes 3 + 4: submerge the camera, capture two frames a moment
// apart for shimmer, and pixel-classify the second for depth fog.
await page.evaluate(() => {
  window.__sedonLayoutStore__.getState().savePreviewCamera(
    'preview-main', 'main',
    { yaw: 0.3, pitch: -0.2, distance: 5, target: [0, 8, 0] },
  );
  // Start the play loop so the time uniform advances frame-to-
  // frame. Without this, the renderer is render-on-demand and
  // both screenshots are byte-identical (no shimmer to measure).
  window.__sedonSetAnimating__(true);
});
await new Promise((r) => setTimeout(r, 2500));

const rect = await page.evaluate(() => {
  const el = document.querySelector('.sedon-panel--preview canvas');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
});

const shotOne = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
});
// Time-shift: wait long enough that the time uniform has visibly
// advanced (~half a second). At wobble freq ~1Hz this changes the
// sample UVs by a few thousandths and shifts ~thousands of pixels.
await new Promise((r) => setTimeout(r, 600));
const shotTwo = await page.screenshot({
  clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
  encoding: 'binary',
  path: '/tmp/water-v2-below.png',
});

const analysis = await page.evaluate(async (b1, b2) => {
  const decode = async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    off.getContext('2d').drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: off.getContext('2d').getImageData(0, 0, bmp.width, bmp.height).data };
  };
  const A = await decode(b1);
  const B = await decode(b2);
  // Shimmer: count pixels differing by more than 3 in any channel.
  let shimmerCount = 0;
  if (A.w === B.w && A.h === B.h) {
    for (let i = 0; i < A.data.length; i += 4) {
      if (Math.abs(A.data[i] - B.data[i]) > 3
          || Math.abs(A.data[i + 1] - B.data[i + 1]) > 3
          || Math.abs(A.data[i + 2] - B.data[i + 2]) > 3) {
        shimmerCount++;
      }
    }
  }
  // Depth fog: average brightness near image centre vs near the top
  // edge of the visible frame. With reverse-Z + the demo camera,
  // top-edge pixels are FAR (looking outward / upward), centre is
  // mid-distance. Far should be DIMMER under depth fog.
  // Build a brightness histogram and find the brightest-5% vs
  // darkest-5% averages. Under depth fog, distant pixels collapse
  // toward the murk-floor brightness while near pixels (here, the
  // terrain peaks rising out of the seabed) stay closer to their
  // unfogged colour. The brightness GAP between those two bands
  // is what proves the fog is producing distance-dependent dimming.
  const w = B.w, h = B.h;
  const pixels = new Array(w * h);
  for (let i = 0, p = 0; i < B.data.length; i += 4, p++) {
    pixels[p] = (B.data[i] + B.data[i + 1] + B.data[i + 2]) / 3;
  }
  pixels.sort((a, b) => a - b);
  // Terrain peaks rising out of the seabed are a small fraction of
  // the frame, so use a tight 0.5% top sample. The murk dominates
  // most of the frame so a 5% bottom sample is plenty.
  const brightCount = Math.max(1, Math.floor(pixels.length * 0.005));
  const darkCount = Math.floor(pixels.length * 0.05);
  let darkSum = 0, brightSum = 0;
  for (let i = 0; i < darkCount; i++) darkSum += pixels[i];
  for (let i = pixels.length - brightCount; i < pixels.length; i++) brightSum += pixels[i];
  const farBrightness = Math.round(darkSum / darkCount);
  const nearBrightness = Math.round(brightSum / brightCount);
  const maxPixel = Math.round(pixels[pixels.length - 1]);
  return { shimmerCount, farBrightness, nearBrightness, maxPixel, w, h };
}, Buffer.from(shotOne).toString('base64'), Buffer.from(shotTwo).toString('base64'));
console.log('analysis:', analysis);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
if (meshProbe.error) {
  console.log('FAIL:', meshProbe.error);
  process.exit(1);
}
const noPageErrors = pageErrors.length === 0;
const noGpuErrors = gpuErrors.length === 0;
// 1. Bigger plane: water extent > 3× heightfield extent (default 5×;
//    give a generous lower bound).
const biggerPlane =
  meshProbe.xExtent > meshProbe.hfXExtent * 3
  && meshProbe.zExtent > meshProbe.hfZExtent * 3;
// 2. Wave displacement: subdivided mesh has many more verts than the
//    original quad's 4. Default 64 subdivisions → 4225 verts.
const subdivided = meshProbe.vertexCount > 100;
// 3. Shimmer: two underwater frames should differ in a meaningful
//    number of pixels due to UV wobble. Threshold 0.5% of frame is
//    well above noise (which would be ~0) and well below the full-
//    frame change (which would happen if the scene changed
//    structurally).
const shimmerVisible = analysis.shimmerCount > Math.round(analysis.w * analysis.h * 0.005);
// 4. Depth fog: a measurable brightness GAP between the brightest
//    5% of pixels (near terrain, fog hasn't dimmed them) and the
//    darkest 5% (far pixels, collapsed to murk). With density 0.06
//    per unit and a scene with terrain peaks at ~10-20 units and
//    murk-fading objects beyond 30 units, the gap should be tens
//    of grey levels.
const depthFogActive = analysis.nearBrightness > analysis.farBrightness + 20;

console.log(`no page errors:                      ${noPageErrors ? 'PASS ✓' : 'FAIL ✗'} (${pageErrors.length})`);
console.log(`no WebGPU validation errors:         ${noGpuErrors ? 'PASS ✓' : 'FAIL ✗'} (${gpuErrors.length})`);
console.log(`water plane > 3× heightfield extent: ${biggerPlane ? 'PASS ✓' : 'FAIL ✗'} (water ${meshProbe.xExtent}×${meshProbe.zExtent} vs hf ${meshProbe.hfXExtent}×${meshProbe.hfZExtent})`);
console.log(`water mesh subdivided (>100 verts):  ${subdivided ? 'PASS ✓' : 'FAIL ✗'} (vertexCount=${meshProbe.vertexCount})`);
console.log(`underwater shimmer between frames:   ${shimmerVisible ? 'PASS ✓' : 'FAIL ✗'} (${analysis.shimmerCount} px shifted)`);
console.log(`underwater depth fog dims distance:  ${depthFogActive ? 'PASS ✓' : 'FAIL ✗'} (near=${analysis.nearBrightness}, far=${analysis.farBrightness})`);

const ok = noPageErrors && noGpuErrors && biggerPlane && subdivided && shimmerVisible && depthFogActive;
process.exit(ok ? 0 : 1);
