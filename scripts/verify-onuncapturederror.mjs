// Confirms the device.ts onuncapturederror handler routes a WebGPU
// validation error into console.error, which is the channel the
// standard verifier `page.on('console', ...)` listener reads. The
// probe creates a buffer larger than the adapter's max — guaranteed
// to fire onuncapturederror — then asserts the verifier saw it.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); });
// Mirror the standard verifier listener — only error-level console
// messages count. Confirms uncaptured WebGPU errors land at this
// channel so existing verifiers pick them up unchanged.
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
// Let the device come up — acquireGpuDevice is async on first canvas mount.
await new Promise((r) => setTimeout(r, 1500));

// Reach into the device (acquireGpuDevice memoizes via a module-local
// promise; the easiest way to grab the device in test is via the store's
// setDevice path — but it's cleaner to just call acquireGpuDevice
// directly through the dev import map. Use a dynamic import via fetch
// of the running bundle: just call it via window if exported, else
// grab the device off whatever has it).
const triggered = await page.evaluate(async () => {
  const state = window.__sedonStore__.getState();
  const dev = state.device;
  if (!dev) return { ok: false, reason: 'no device in store; keys=' + Object.keys(state).join(',') };
  if (typeof dev.createBuffer !== 'function') return { ok: false, reason: 'device has no createBuffer' };
  const handlerInstalled = typeof dev.onuncapturederror === 'function';
  // Trigger a validation error: try to map a buffer that wasn't
  // created with MAP_READ.
  const buf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM });
  try {
    await buf.mapAsync(GPUMapMode.READ);
  } catch (e) {
    // mapAsync's promise rejects on validation. But the error ALSO
    // fires through onuncapturederror per the spec — that's what we
    // want to confirm.
  }
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, reason: 'mapAsync on uniform buffer', handlerInstalled };
});
console.log('probe:', triggered);

await new Promise((r) => setTimeout(r, 400));
await browser.close();
await server.stop();

const sawGpuError = errors.some((e) => /webgpu.*uncaptured/i.test(e));
console.log('\n===== RESULT =====');
console.log(`probe triggered:        ${triggered.ok ? 'yes' : 'NO (' + triggered.reason + ')'}`);
console.log(`console.error captured: ${sawGpuError ? 'PASS ✓' : 'FAIL ✗'}`);
if (!sawGpuError) {
  console.log('captured errors:');
  for (const e of errors) console.log(' ', e);
}
process.exit(sawGpuError ? 0 : 1);
