// Repro for the bug where Macro → Stop Recording stayed grey after
// clicking Record. Root cause: recording.ts kept its `active` flag as
// a plain module-local variable; useActions read it via
// recordingActive() without subscribing, so React never re-rendered
// the menu when recording started. The fix exposes
// useRecordingActive() (useSyncExternalStore-backed) and switches
// useActions to use it. This script reopens the Macro menu after
// clicking Record and asserts Stop Recording is now enabled.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
console.log('dev server:', server.url);

const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); console.error('PAGEERROR:', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errors.push(`[err] ${msg.text()}`); console.error('CONSOLE-ERR:', msg.text()); }
});

// Macro menu is gated to ?allow-macros=1. Without that flag the menu
// doesn't appear at all and this verifier has nothing to drive.
await page.goto(`${server.url}?debug=1&allow-macros=1`, { waitUntil: 'networkidle2', timeout: 30000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 10000 });
await new Promise((r) => setTimeout(r, 500));

async function openMacroMenu() {
  const handle = await page.evaluateHandle(() => {
    return [...document.querySelectorAll('.sedon-menubar-item')]
      .find((el) => el.textContent?.trim() === 'Macro');
  });
  const el = handle.asElement();
  if (!el) throw new Error('Macro top-level menu not found');
  await el.click();
  await new Promise((r) => setTimeout(r, 150));
}

async function readMacroItems() {
  return page.evaluate(() => {
    return [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row')].map((row) => {
      const label = row.querySelector('.sedon-menu-row-label')?.textContent?.trim() ?? '';
      // menubar.tsx marks a disabled row by appending a child overlay
      // span; that's the load-bearing signal we read here.
      const disabled = !!row.querySelector('.sedon-menu-row-disabled-overlay');
      return { label, disabled };
    });
  });
}

async function closeMenus() {
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 100));
}

await openMacroMenu();
const initial = await readMacroItems();
console.log('Macro menu (initial):', initial);
await closeMenus();

const recordRow = initial.find((r) => r.label.includes('Record') && !r.label.includes('Stop'));
const stopRow0 = initial.find((r) => r.label.includes('Stop'));
const initialOk = recordRow && stopRow0
  && recordRow.disabled === false
  && stopRow0.disabled === true;

// Click Record via the menu.
await openMacroMenu();
const clicked = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.sedon-menubar-popup .sedon-menu-row')]
    .find((r) => {
      const t = r.querySelector('.sedon-menu-row-label')?.textContent?.trim() ?? '';
      return t.includes('Record') && !t.includes('Stop');
    });
  if (!row) return false;
  const box = row.getBoundingClientRect();
  // Just synthesize a click via mouse coords.
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
});
if (!clicked) {
  console.log('FAIL: could not locate Record row to click');
  await browser.close();
  await server.stop();
  process.exit(1);
}
await page.mouse.click(clicked.x, clicked.y);
await new Promise((r) => setTimeout(r, 250));

// Reopen Macro menu and inspect Stop Recording.
await openMacroMenu();
const afterRecord = await readMacroItems();
console.log('Macro menu (after Record click):', afterRecord);

const recordRow2 = afterRecord.find((r) => r.label.includes('Record') && !r.label.includes('Stop'));
const stopRow2 = afterRecord.find((r) => r.label.includes('Stop'));
const afterOk = recordRow2 && stopRow2
  && recordRow2.disabled === true
  && stopRow2.disabled === false;

await closeMenus();
await browser.close();
await server.stop();

console.log('\n===== RESULT =====');
console.log(`initial: Record enabled, Stop disabled:  ${initialOk ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`after Record: Record disabled, Stop enabled: ${afterOk ? 'PASS ✓' : 'FAIL ✗'}`);
console.log(`console clean:                            ${errors.length === 0 ? 'PASS ✓' : 'FAIL ✗'}`);
const ok = initialOk && afterOk && errors.length === 0;
console.log(ok ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
process.exit(ok ? 0 : 1);
