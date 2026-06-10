// Load a node doc page (tex/perlin), scroll to bottom, and screenshot
// the bottom mini-TOC so we can eyeball the 300 px column layout and
// the "current node" highlight.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
await page.goto(`${server.url}docs/nodes/tex/perlin/`, { waitUntil: 'networkidle2' });
// Give React + the in-page sample preview a beat to mount so the page
// is at its final scroll height.
await new Promise((r) => setTimeout(r, 2500));

const toc = await page.$('.sedon-doc-bottom-toc');
if (toc) {
  await page.evaluate((el) => el.scrollIntoView({ block: 'start' }), toc);
  await new Promise((r) => setTimeout(r, 300));
  await toc.screenshot({ path: '/tmp/bottom-toc.png' });
  console.log('saved /tmp/bottom-toc.png');

  const summary = await toc.evaluate((el) => {
    const cols = el.querySelectorAll('.sedon-doc-bottom-toc-col');
    const current = el.querySelector('.sedon-doc-bottom-toc-current');
    const firstLink = el.querySelector('.sedon-doc-bottom-toc-list a');
    return {
      categoryCount: cols.length,
      currentLabel: current?.textContent?.trim() ?? '(none)',
      firstLinkHref: firstLink?.getAttribute('href') ?? '(none)',
      gridColumns: getComputedStyle(el.querySelector('.sedon-doc-bottom-toc-grid')).gridTemplateColumns,
    };
  });
  console.log(summary);
} else {
  console.log('no .sedon-doc-bottom-toc on page');
}

await browser.close();
await server.stop();
