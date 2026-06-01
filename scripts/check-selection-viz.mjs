// Capture the docs preview for core/select-by-angle so we can verify
// (a) the new selection visualization actually renders, and (b) the
// squashed-sphere sample produces a partial selection (some edges
// orange/red, others green/blue).
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const pages = [
  'docs/nodes/core/select-by-angle/',
  'docs/nodes/core/select-invert/',
  'docs/nodes/core/select-combine/',
];

try {
  for (const p of pages) {
    await page.goto(`${server.url}${p}?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 2500));
    const count = await page.evaluate(() => {
      const state = window.__sedonStore__.getState();
      const root = state.graph.nodes.find((n) => n.kind === 'core/select-by-angle' || n.kind === 'core/select-invert' || n.kind === 'core/select-combine');
      return { kinds: state.graph.nodes.map(n => n.kind), root: root?.kind };
    });
    console.log(p, JSON.stringify(count));
    const name = p.replace(/\//g, '_');
    await page.screenshot({ path: `/tmp/${name}.png` });
    console.log('  →', `/tmp/${name}.png`);
  }
  if (errors.length > 0) {
    console.log('ERRORS:');
    for (const e of errors) console.log('  ', e);
  }
} finally {
  await browser.close();
  server.stop();
}
