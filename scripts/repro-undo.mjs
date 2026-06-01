// Reproduce the user's report: open lathe docs → open curve-2d editor →
// click canvas to add a point → Cmd+Z should undo. Check undoStack
// state before/after each step.
import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 1000 } });
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

try {
  await page.goto(`${server.url}docs/nodes/core/lathe/?debug=1`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 2500));

  const curveId = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return { id: n?.id, points: (n?.inputValues?.points)?.length ?? 0, undoLen: state.undoStack.length };
  });
  console.log('before editor open:', JSON.stringify(curveId));

  // Open editor.
  await page.evaluate(() => {
    document.querySelector('.sedon-pointlist-trigger')?.click();
  });
  await new Promise((r) => setTimeout(r, 400));

  // Click on the SVG to add a point.
  const svgBox = await page.evaluate(() => {
    const svg = document.querySelector('.sedon-pointlist-svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    return { x: r.x + r.width / 2 + 80, y: r.y + r.height / 2 - 80 };
  });
  await page.mouse.click(svgBox.x, svgBox.y);
  await new Promise((r) => setTimeout(r, 300));

  const afterClick = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return {
      points: (n?.inputValues?.points)?.length ?? 0,
      undoLen: state.undoStack.length,
      lastCmdKind: state.undoStack[state.undoStack.length - 1]?.kind ?? null,
    };
  });
  console.log('after click:', JSON.stringify(afterClick));

  // What element is focused?
  const focusInfo = await page.evaluate(() => {
    const a = document.activeElement;
    return {
      tagName: a?.tagName ?? null,
      className: a?.className ?? null,
    };
  });
  console.log('active element:', JSON.stringify(focusInfo));

  // Press Cmd+Z.
  await page.keyboard.down('Meta');
  await page.keyboard.press('z');
  await page.keyboard.up('Meta');
  await new Promise((r) => setTimeout(r, 300));

  const afterUndo = await page.evaluate(() => {
    const state = window.__sedonStore__.getState();
    const n = state.graph.nodes.find((n) => n.kind === 'core/curve-2d');
    return {
      points: (n?.inputValues?.points)?.length ?? 0,
      undoLen: state.undoStack.length,
      redoLen: state.redoStack.length,
    };
  });
  console.log('after Cmd+Z:', JSON.stringify(afterUndo));
  if (errors.length > 0) for (const e of errors) console.log('  err:', e);
} finally {
  await browser.close();
  server.stop();
}
