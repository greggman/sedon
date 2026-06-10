// End-to-end check: drag a node, press Cmd-Z, expect the node to
// return to its starting position. Drives the canvas exactly the way
// a user would.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));

await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => typeof window.__sedonStore__ !== 'undefined', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 2500));

// Pick the first node in the active graph. Read its starting position
// from the editor store, then drag it on screen, then read the new
// position, then undo, then read the post-undo position.
async function readPosition(id) {
  return page.evaluate((nid) => {
    const s = window.__sedonStore__.getState();
    return s.nodePositions[s.currentEditingId]?.[nid] ?? null;
  }, id);
}
const firstId = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  return s.graph.nodes[0]?.id ?? null;
});
if (!firstId) throw new Error('no nodes in scene=basic to drag');
const before = await readPosition(firstId);
console.log('start:', before);

// Find the RF node element on screen and drag it ~150px.
const sel = `.react-flow__node[data-id="${firstId}"]`;
const handle = await page.$(sel);
if (!handle) throw new Error(`node element ${sel} not found in DOM`);
const box = await handle.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
// Drag in steps so RF reports motion. End somewhere clearly different.
await page.mouse.move(box.x + 200, box.y + 150, { steps: 8 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 400));

const dropped = await readPosition(firstId);
console.log('dropped:', dropped);

// Cmd-Z (on macOS) / Ctrl-Z. Puppeteer keyboard.down treats key codes
// as case-sensitive; on darwin we use Meta.
await page.keyboard.down('Meta');
await page.keyboard.press('z');
await page.keyboard.up('Meta');
await new Promise((r) => setTimeout(r, 400));

const restored = await readPosition(firstId);
console.log('after undo:', restored);

await browser.close();
await server.stop();

const distMoved = Math.hypot((dropped.x - before.x), (dropped.y - before.y));
const distRestored = Math.hypot((restored.x - before.x), (restored.y - before.y));
if (distMoved < 20) { console.error('drag did not register'); process.exit(1); }
if (distRestored > 1) { console.error('undo did not restore'); process.exit(1); }
console.log('OK — drag moved by', distMoved.toFixed(1), 'px, undo restored to within', distRestored.toFixed(2), 'px');
