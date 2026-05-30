// Open the branch/space-colonization docs page, screenshot the live
// sample preview so we can see what the algorithm actually produces.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() !== 'log') console.log(`[${msg.type()}]`, msg.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}docs/nodes/branch/space-colonization/`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 5000));

// Screenshot the embedded sample preview (the panel on the right).
const preview = await page.$('.sedon-doc-sample-result, .sedon-doc-sample');
if (preview) {
  await preview.screenshot({ path: '/tmp/space-col-sample.png' });
  console.log('saved /tmp/space-col-sample.png');
}
await page.screenshot({ path: '/tmp/space-col-full.png' });
console.log('saved /tmp/space-col-full.png');

await browser.close();
await server.stop();
