// Verify the curve-2d Bezier-handle editor end-to-end:
//   • Open editor on the lathe docs scene.
//   • Click an anchor to select it; press T to promote to FREE.
//   • Confirm two tangent dots + lines render.
//   • Drag a tangent dot; confirm the stored handle deltas change
//     and the displayed bezier path responds.
//   • Confirm the underlying inputValue picks up 7-number tuples.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console]:', msg.text()); });
page.on('pageerror', (e) => console.log('  [pageerror]:', e.message));

try {
  await page.goto(`${server.url}docs/nodes/core/lathe/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Open editor.
  await page.evaluate(() => {
    document.querySelector('.sedon-pointlist-trigger')?.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  // Click on the third anchor (a smooth one in the middle of the
  // candlestick) to select it. Puppeteer event-target the SVG circle
  // by index.
  const anchorBefore = await page.evaluate(() => {
    const anchors = document.querySelectorAll('.sedon-pointlist-handle');
    const a = anchors[3];
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('anchor 3 pos:', anchorBefore);
  await page.mouse.click(anchorBefore.x, anchorBefore.y);
  await new Promise((r) => setTimeout(r, 200));

  // Verify selection
  const selected = await page.evaluate(() => {
    return document.querySelectorAll('.sedon-pointlist-handle--selected').length;
  });
  console.log('selected anchors:', selected);

  // Press T to cycle handle type AUTO → FREE.
  await page.keyboard.press('t');
  await new Promise((r) => setTimeout(r, 200));

  // Now should see two tangent dots for that anchor.
  const tangentCount = await page.evaluate(() => {
    return document.querySelectorAll('.sedon-pointlist-tangent').length;
  });
  console.log('tangent dots after T (expect 2):', tangentCount);

  // Inspect the tuple — it should be 7 numbers, type=2 (FREE).
  const pointBefore = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return n?.inputValues?.points?.[3];
  });
  console.log('point 3 after T:', JSON.stringify(pointBefore));

  // Drag the RIGHT tangent dot 30px to the right.
  const rightDot = await page.evaluate(() => {
    const dots = document.querySelectorAll('.sedon-pointlist-tangent');
    // Two dots per selected anchor; right one is the second.
    const d = dots[1];
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  console.log('right tangent dot pos:', rightDot);
  await page.mouse.move(rightDot.x, rightDot.y);
  await page.mouse.down();
  await page.mouse.move(rightDot.x + 30, rightDot.y, { steps: 5 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));

  // Inspect tuple again — the rDx (index 5) should have changed.
  const pointAfter = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return n?.inputValues?.points?.[3];
  });
  console.log('point 3 after drag:', JSON.stringify(pointAfter));

  const moved = pointBefore && pointAfter
    && (Math.abs((pointAfter[5] ?? 0) - (pointBefore[5] ?? 0)) > 0.01
        || Math.abs((pointAfter[6] ?? 0) - (pointBefore[6] ?? 0)) > 0.01);
  console.log(moved ? 'PASS: tangent drag updated handle deltas.' : 'FAIL: tangent drag did not move deltas.');

  // Test undo (Cmd+Z) rolls back the drag.
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await new Promise((r) => setTimeout(r, 200));

  const pointAfterUndo = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return n?.inputValues?.points?.[3];
  });
  console.log('point 3 after Cmd+Z:', JSON.stringify(pointAfterUndo));

  await page.screenshot({ path: '/tmp/curve-2d-handles.png' });
  console.log('screenshot: /tmp/curve-2d-handles.png');
} finally {
  await browser.close();
  server.stop();
}
