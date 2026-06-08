// Verify the unified action registry:
//   1. Open the palette, type "new subgraph" — the previously-missing
//      action should match.
//   2. Click File → New Scene from the menu (drives the same action).
//   3. Spot-check several other menu items by walking the dropdown.

import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';
import fs from 'node:fs';

const OUT = '/tmp/actions';
fs.mkdirSync(OUT, { recursive: true });

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({ headless: 'new', defaultViewport: { width: 1400, height: 900 } });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[err] ${msg.text()}`);
});

try {
  await page.goto(`${server.url}?debug=1&scene=basic&allow-macros=1`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2500));

  // ── 1. Open the palette via Cmd-Shift-P; confirm "Add: New
  //       Subgraph…" appears in the result list. Pre-refactor it
  //       was missing.
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('p');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await new Promise((r) => setTimeout(r, 200));
  await page.type('.sedon-palette-input', 'new subgraph');
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: `${OUT}/01-palette-new-subgraph.png` });

  const paletteLabels = await page.evaluate(() => {
    return [...document.querySelectorAll('.sedon-palette-label')].map((el) => el.textContent);
  });
  console.log('palette match for "new subgraph":', JSON.stringify(paletteLabels));

  // Close palette.
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));

  // ── 2. File menu sanity — walk every entry and verify none reads
  //       "<missing action: …>" (which would indicate a broken ref).
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.sedon-menubar-item')];
    const fileBtn = buttons.find((b) => b.textContent === 'File');
    if (!fileBtn) throw new Error('no File button');
    fileBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  const fileLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent),
  );
  console.log('File menu labels:', JSON.stringify(fileLabels));
  await page.screenshot({ path: `${OUT}/02-file-menu.png` });
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));

  // ── 3. Add menu — verify New Subgraph… appears at the bottom.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.sedon-menubar-item')];
    const addBtn = buttons.find((b) => b.textContent === 'Add');
    if (!addBtn) throw new Error('no Add button');
    addBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 200));
  const addLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent),
  );
  console.log('Add menu labels:', JSON.stringify(addLabels));
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));

  // ── 4. Check no labels rendered as "<missing action: …>" anywhere
  //       (open each top-level menu briefly).
  const missingFound = [];
  for (const topLabel of ['File', 'Edit', 'Add', 'View', 'Macro', 'Help']) {
    const ok = await page.evaluate((label) => {
      const buttons = [...document.querySelectorAll('.sedon-menubar-item')];
      const btn = buttons.find((b) => b.textContent === label);
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return true;
    }, topLabel);
    if (!ok) {
      console.log(`(no ${topLabel} top-level button — ok if gated)`);
      continue;
    }
    await new Promise((r) => setTimeout(r, 150));
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.sedon-menu-row-label')].map((el) => el.textContent),
    );
    for (const lbl of labels) {
      if (lbl && lbl.startsWith('<missing')) missingFound.push(`${topLabel}: ${lbl}`);
    }
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 150));
  }

  // ── Verdict
  const checks = [
    ['palette finds "Add: New Subgraph…"', paletteLabels.some((l) => l === 'Add: New Subgraph…')],
    ['File menu has "New Scene"', fileLabels.includes('New Scene')],
    ['Add menu has "New Subgraph…"', addLabels.includes('New Subgraph…')],
    ['no <missing action> rows', missingFound.length === 0],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  if (missingFound.length > 0) {
    console.log('  missing-action rows found:');
    for (const m of missingFound) console.log(`    ${m}`);
  }

  if (errors.length) {
    console.log('\nConsole errors:');
    for (const e of errors) console.log(' ', e);
  }
  console.log(allPass && errors.length === 0 ? '\nOVERALL: PASS' : '\nOVERALL: FAIL');
} finally {
  await browser.close();
  await server.stop();
}
