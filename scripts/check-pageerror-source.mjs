// Trace where the "Cannot read properties of undefined (reading 'nodes')"
// pageerror comes from when loading the recording's project state.
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { startDevServer } from './lib/dev-server.mjs';

const recording = JSON.parse(fs.readFileSync('/Users/gregg/Downloads/sedon-2026-06-01-06-55-42.sedon-rec', 'utf8'));
const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
page.on('pageerror', (e) => {
  console.log('[pageerror]', e.message);
  console.log(e.stack?.split('\n').slice(0, 10).join('\n'));
});

try {
  await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 1500));

  console.log('--- before setState ---');
  await page.evaluate((recording) => {
    const proj = recording.startProject;
    window.__sedonStore__.setState({
      subgraphs: proj.subgraphs ?? [],
      mainGraph: proj.mainGraph,
      mainRootNodeId: proj.mainRootNodeId ?? 'main',
      graph: proj.mainGraph,
      rootNodeId: proj.mainRootNodeId ?? 'main',
      currentEditingId: 'main',
    });
  }, recording);
  await new Promise((r) => setTimeout(r, 1500));
  console.log('--- after setState ---');
} finally {
  await browser.close();
  server.stop();
}
