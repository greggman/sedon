// Load the city-furniture-preview demo and screenshot the result so
// I can visually iterate on lamp post / traffic signal / fire hydrant
// / car proportions before they get used in the real 5×5 city scene.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/city-furniture';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

try {
  await page.goto(
    `${server.url}?debug=1&scene=city-furniture-preview`,
    { waitUntil: 'networkidle2', timeout: 30000 },
  );
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 4000));

  await page.screenshot({ path: `${OUT}/overview.png` });

  const state = await page.evaluate(() => {
    const s = window.__sedonStore__.getState();
    return {
      subgraphCount: s.subgraphs.length,
      subgraphIds: s.subgraphs.map((sg) => sg.id),
      mainNodeKinds: s.mainGraph.nodes.map((n) => n.kind),
    };
  });
  console.log('Demo state:', JSON.stringify(state, null, 2));

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(errors.length === 0 ? '\nOVERALL: PASS (open /tmp/city-furniture/overview.png)' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
