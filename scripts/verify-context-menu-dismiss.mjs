// Verify two dismissal regressions:
//
//   Bug 1: node context menu (right-click a canvas node) wouldn't
//          dismiss period. Now: clicking the canvas pane dismisses;
//          Escape dismisses; clicking another node dismisses.
//
//   Bug 2: asset context menu opened on an asset row would NOT
//          dismiss when clicking inside the canvas (it did dismiss
//          when clicking inside the asset view). Now: any click
//          outside the menu dismisses, including in the canvas.

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

const focusPanel = async (panelId) => {
  await page.evaluate((id) => {
    const api = window.__sedonGetDockview__?.();
    api?.getPanel(id)?.api.setActive();
  }, panelId);
  await new Promise((r) => setTimeout(r, 200));
};

async function getNodeMenuPresent() {
  return page.evaluate(() => {
    // The node context menu is the portal'd .sedon-menubar-submenu
    // with z-index 1000.
    return !!document.querySelector('.sedon-menubar-submenu[style*="z-index: 1000"]');
  });
}

async function getAssetMenuPresent() {
  return page.evaluate(
    () => !!document.querySelector('.sedon-assets-context-menu'),
  );
}

try {
  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Seed: create a subgraph from a canvas so we have a wrapper to
  // right-click. Commit the rename quickly so we have a stable node.
  await focusPanel('canvas-main');
  await page.evaluate(async () => {
    await window.sedonMcp.call('runAction', { id: 'add.new-subgraph' });
  });
  await new Promise((r) => setTimeout(r, 500));
  const input = await page.$('.sedon-editable-name-input');
  if (input) {
    await input.click({ clickCount: 3 });
    await page.keyboard.type('wrapper-A');
    await page.keyboard.press('Enter');
  }
  await new Promise((r) => setTimeout(r, 300));

  // ─── Bug 1a: open node context menu, click canvas pane → dismiss
  const nodeRect = await page.evaluate(() => {
    const target = [...document.querySelectorAll('.sedon-node')]
      .find((n) => n.textContent?.includes('wrapper-A'));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 12 };
  });
  if (!nodeRect) throw new Error('no wrapper-A node found');
  await page.mouse.click(nodeRect.x, nodeRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const nodeMenuOpened = await getNodeMenuPresent();

  // Click an empty area of the canvas pane (away from the menu and node).
  const paneRect = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane');
    if (!pane) return null;
    const r = pane.getBoundingClientRect();
    // Bottom-left corner of the pane, far from the node.
    return { x: r.left + 40, y: r.bottom - 40 };
  });
  await page.mouse.click(paneRect.x, paneRect.y);
  await new Promise((r) => setTimeout(r, 200));
  const nodeMenuAfterPaneClick = await getNodeMenuPresent();

  // ─── Bug 1b: open node context menu, press Escape → dismiss
  await page.mouse.click(nodeRect.x, nodeRect.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const reopened1 = await getNodeMenuPresent();
  await page.keyboard.press('Escape');
  await new Promise((r) => setTimeout(r, 200));
  const nodeMenuAfterEsc = await getNodeMenuPresent();

  // ─── Bug 2: open asset context menu, click canvas → dismiss
  await focusPanel('assets-main');
  // Right-click on the wrapper-A subgraph tile in the asset view.
  const tileRect = await page.evaluate(() => {
    const tile = document.querySelector('[data-asset-id="wrapper-a"]');
    if (!tile) return null;
    const r = tile.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!tileRect) {
    // Fall back: find any subgraph tile.
    const anyTile = await page.evaluate(() => {
      const t = document.querySelector('[data-asset-id]');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!anyTile) throw new Error('no asset tile found');
    Object.assign(tileRect ?? {}, anyTile);
  }
  const target = tileRect ?? (await page.evaluate(() => {
    const t = document.querySelector('[data-asset-id]');
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }));
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const assetMenuOpened = await getAssetMenuPresent();

  // Click an empty canvas area to dismiss.
  await page.mouse.click(paneRect.x, paneRect.y);
  await new Promise((r) => setTimeout(r, 200));
  const assetMenuAfterCanvasClick = await getAssetMenuPresent();

  // ─── Bug 2 sanity: clicking inside the asset view also dismisses
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await new Promise((r) => setTimeout(r, 200));
  const reopened2 = await getAssetMenuPresent();
  const assetEmptyRect = await page.evaluate(() => {
    const panel = document.querySelector('.sedon-assets-pane') ||
                  document.querySelector('[class*="assets"]');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    // Click in the bottom area where there's likely no tile.
    return { x: r.left + 20, y: r.bottom - 20 };
  });
  if (assetEmptyRect) {
    await page.mouse.click(assetEmptyRect.x, assetEmptyRect.y);
  } else {
    // Fallback: press Escape.
    await page.keyboard.press('Escape');
  }
  await new Promise((r) => setTimeout(r, 200));
  const assetMenuAfterAssetEmpty = await getAssetMenuPresent();

  const checks = [
    ['Bug 1: node context menu opened on right-click', nodeMenuOpened],
    ['Bug 1: node menu dismissed by canvas-pane click', !nodeMenuAfterPaneClick],
    ['Bug 1: node menu re-opens on right-click', reopened1],
    ['Bug 1: node menu dismissed by Escape', !nodeMenuAfterEsc],
    ['Bug 2: asset context menu opened on right-click', assetMenuOpened],
    ['Bug 2: asset menu dismissed by canvas click', !assetMenuAfterCanvasClick],
    ['Bug 2: asset menu re-opens', reopened2],
    ['Bug 2: asset menu dismissed by asset-area click', !assetMenuAfterAssetEmpty],
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
