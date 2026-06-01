// Sanity check the new core/compute-normals node by rendering its
// docs sample scene and capturing a screenshot. Visual smoke test —
// the algorithm is unit-tested; this just verifies the node wires
// up + the GPU mesh round-trips through the renderer.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

try {
  await page.goto(`${server.url}docs/nodes/core/compute-normals/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Verify the eval ran cleanly and produced output.
  const info = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const cn = state.graph.nodes.find((n) => n.kind === 'core/compute-normals');
    return {
      hasNode: !!cn,
      cuspDefault: cn?.inputValues?.cusp_angle,
      nodeCount: state.graph.nodes.length,
    };
  });
  console.log('docs scene state:', JSON.stringify(info));

  await page.screenshot({ path: '/tmp/compute-normals.png' });
  console.log('screenshot: /tmp/compute-normals.png');

  if (errors.length > 0) {
    console.log('ERRORS:');
    for (const e of errors) console.log('  ', e);
  } else {
    console.log('PASS: no console errors during compute-normals docs render.');
  }
} finally {
  await browser.close();
  server.stop();
}
