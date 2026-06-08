import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/broken';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1000, height: 700 },
  protocolTimeout: 120_000,
});

const scenes = ['grass-test', 'multi-layer-terrain', 'forest'];

for (const scene of scenes) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    // Capture every console message — WebGPU validation often comes
    // out as plain 'log' or 'warning', not 'error'.
    const t = msg.text();
    if (t.match(/webgpu|gpu|validation|bind group|pipeline|shader/i)) {
      errors.push(`${msg.type().toUpperCase()}: ${t}`);
    }
  });

  // Install an onuncapturederror handler on every GPUDevice created in
  // the page. WebGPU validation errors fire here, NOT to console by
  // default — we have to wire them up explicitly.
  await page.evaluateOnNewDocument(() => {
    window.__gpuErrors__ = [];
    const origRequestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const device = await origRequestDevice.apply(this, args);
      device.addEventListener('uncapturederror', (e) => {
        window.__gpuErrors__.push(`UNCAPTURED: ${e.error.message}`);
        console.error('GPU uncaptured error:', e.error.message);
      });
      return device;
    };
  });

  try {
    await page.goto(`${server.url}?debug=1&scene=${scene}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 5000));
    await page.screenshot({ path: `${OUT}/${scene}.png` });
    const gpuErrors = await page.evaluate(() => window.__gpuErrors__ || []);
    for (const e of gpuErrors) errors.push(e);
  } catch (e) {
    errors.push(`THROW: ${e.message}`);
  }

  console.log(`\n=== ${scene} ===`);
  if (errors.length === 0) console.log('(no errors)');
  for (const e of errors.slice(0, 20)) console.log(' ', e);
  if (errors.length > 20) console.log(` ... (${errors.length - 20} more)`);
  await page.close();
}

await browser.close();
await server.stop();
