// Regression: after loading a demo (which resets the layout store and
// clears every preview's pin), right-click subgraph → "Open in Canvas"
// must NOT swap the preview. Open-in-canvas calls setActiveEditing,
// which flips currentEditingId; an unpinned preview follows it. The
// preview should stay pinned to its own graph and ignore the canvas
// change.

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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(`${server.url}?debug=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await page.waitForFunction(() => typeof window.__sedonOpenGraphInCanvas__ === 'function', { timeout: 10000 });

// Load forest (this runs setGraph → resetForNewProject → clears pins).
await page.evaluate(() => {
  const demo = window.__sedonDemos__.find((d) => d.id === 'forest');
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  window.__sedonStore__.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
});
await new Promise((r) => setTimeout(r, 3000));

const probe = () => page.evaluate(() => {
  const ed = window.__sedonStore__.getState();
  const lay = window.__sedonLayoutStore__.getState();
  return {
    currentEditingId: ed.currentEditingId,
    pins: { ...lay.pinnedGraphIds },
  };
});

const before = await probe();
console.log('\nAFTER forest load:');
console.log('  currentEditingId:', before.currentEditingId);
console.log('  preview pins:    ', JSON.stringify(before.pins));

// Pick a subgraph to open in the canvas.
const sgId = await page.evaluate(() => window.__sedonStore__.getState().subgraphs[0]?.id ?? null);
console.log('\nOpening subgraph in canvas:', sgId);
await page.evaluate((id) => window.__sedonOpenGraphInCanvas__(id), sgId);
await new Promise((r) => setTimeout(r, 1500));

const after = await probe();
console.log('\nAFTER open-in-canvas:');
console.log('  currentEditingId:', after.currentEditingId, '(expected: the subgraph id)');
console.log('  preview pins:    ', JSON.stringify(after.pins));

await browser.close();
await server.stop();

// The preview pin must still point at its own graph (main), NOT the
// subgraph the canvas just switched to.
const previewPanelId = Object.keys(after.pins)[0];
const previewGraph = after.pins[previewPanelId];
const canvasSwitched = after.currentEditingId === sgId;
const previewHeld = previewGraph === before.pins[previewPanelId] && previewGraph !== sgId;

console.log('\n===== RESULT =====');
console.log('canvas switched to subgraph:', canvasSwitched ? 'YES ✓' : 'NO ✗');
console.log('preview held its own graph:  ', previewHeld ? 'YES ✓' : `NO ✗ (became ${previewGraph})`);
console.log(canvasSwitched && previewHeld ? '\nPASS' : '\nFAIL');
process.exit(canvasSwitched && previewHeld ? 0 : 1);
