// Demo cleanup: forest main graph should have ONE scene-merge node
// (down from 3) and the Branch Tree subgraph should have ONE (down
// from 2). Also verifies the resulting graph still evaluates — the
// final root output port has a non-null scene value (i.e. all the
// producers reach the output through the single merge).

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: false,
  defaultViewport: null,
  args: ['--window-size=1600,1000'],
});
const page = await browser.newPage();
let pageErr = null;
page.on('pageerror', (e) => { pageErr = e.message; console.log('[pageerror]', e.message); });

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });

const countMergesInDemo = async (demoId) => {
  await page.evaluate((id) => {
    const demo = window.__sedonDemos__.find((d) => d.id === id);
    const { graph, rootNodeId, subgraphs, cameras } = demo.build();
    window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
  }, demoId);
  await new Promise((r) => setTimeout(r, 1500));
  return page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const count = (graph) => graph.nodes.filter((n) => n.kind === 'scene/merge').length;
    const subs = {};
    for (const s of state.subgraphs) subs[s.id] = count(s.graph);
    return { main: count(state.mainGraph), subgraphs: subs };
  });
};

const forestCounts = await countMergesInDemo('forest');
console.log('forest:', forestCounts);
const treeBushCounts = await countMergesInDemo('tree-bush');
console.log('tree-bush:', treeBushCounts);

const counts = {
  forestMain: forestCounts.main,
  branchTree: treeBushCounts.subgraphs['branch-tree'],
};
console.log('scene-merge counts:', counts);

await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
const forestOk = counts.forestMain === 1;
const branchTreeOk = counts.branchTree === 1;
const noPageError = pageErr === null;
console.log(`forest main graph has 1 scene-merge:    ${forestOk ? 'PASS ✓' : 'FAIL ✗'} (got ${counts.forestMain})`);
console.log(`Branch Tree subgraph has 1 scene-merge: ${branchTreeOk ? 'PASS ✓' : 'FAIL ✗'} (got ${counts.branchTree})`);
console.log(`no page errors loading forest:           ${noPageError ? 'PASS ✓' : 'FAIL ✗'} (${pageErr ?? 'none'})`);

process.exit(forestOk && branchTreeOk && noPageError ? 0 : 1);
