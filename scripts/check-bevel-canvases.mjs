import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1600, height: 1200 } });
const page = await browser.newPage();
try {
  await page.goto(`${server.url}?scene=bevel-test&debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 3500));

  const state = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      cameras: s.cameras,
      editingId: s.editingId,
      rootNodeId: s.rootNodeId,
      nodes: s.graph.nodes.map((n) => ({ id: n.id, kind: n.kind })),
    };
  });
  console.log(JSON.stringify(state, null, 2));
} finally {
  await browser.close();
  server.stop();
}
