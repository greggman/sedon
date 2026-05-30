// Smoke-test: load the TOC + a couple of node pages from the dev
// server and print every <a href> the browser resolves them to. Used
// to verify doc-paths.ts emits relative URLs that resolve to the right
// target page from any depth in the docs tree.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({ headless: 'new' });

async function inspect(url, label) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2' });
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a')).map((a) => ({
      text: a.textContent?.trim().slice(0, 50),
      href: a.getAttribute('href'),
      resolved: a.href,
    })),
  );
  console.log(`\n=== ${label} ===`);
  console.log(`  page url: ${url}`);
  for (const h of hrefs.slice(0, 6)) {
    console.log(`  ${h.href}  →  ${h.resolved}`);
  }
  await page.close();
}

await inspect(`${server.url}docs/`, 'TOC');
await inspect(`${server.url}docs/nodes/core/perlin/`, 'core/perlin');
await inspect(`${server.url}docs/nodes/terrain/hydraulic-erosion/`, 'terrain/hydraulic-erosion');

await browser.close();
await server.stop();
