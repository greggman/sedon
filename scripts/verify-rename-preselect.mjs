// Verify the canvas node rename pre-selects the text.
//
// Triggers the rename-bus path (add.new-subgraph in canvas, which
// auto-opens the wrapper's rename input). Both the auto-open and
// the right-click → Rename paths share the same EditableNodeName
// useEffect-on-edit-transition that does `el.focus(); el.select()`
// — verifying one covers both.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});
page.on('dialog', (d) => { void d.accept(); });

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Focus canvas, fire add.new-subgraph (creates wrapper + auto-rename).
  await page.evaluate(() => {
    window.__sedonGetDockview__?.()?.getPanel('canvas-main')?.api.setActive();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 500));

  // Inspect the freshly-mounted rename input on the wrapper.
  const sel = await page.evaluate(() => {
    const inp = document.querySelector('.sedon-editable-name-input');
    if (!inp) return null;
    return {
      value: inp.value,
      selectionStart: inp.selectionStart,
      selectionEnd: inp.selectionEnd,
    };
  });
  console.log('Canvas rename input state on auto-open:', JSON.stringify(sel));

  const checks = [
    ['Input mounted on auto-open', !!sel],
    ['Input pre-filled with default label', sel?.value === 'untitled subgraph'],
    ['Selection starts at 0', sel?.selectionStart === 0],
    ['Selection ends at text length',
      sel && sel.selectionEnd === sel.value.length],
    ['Selection covers the entire text (not just caret-at-end)',
      sel && sel.selectionStart < sel.selectionEnd],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  if (errors.length) {
    console.log('\nErrors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(allPass && errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
