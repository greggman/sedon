// Drive Sedon's MCP surface from a fake "LLM" client running in the
// page context. Verify:
//   1. window.sedonMcp exposes listActions and runAction.
//   2. listActions returns the actions registry (incl. add.new-subgraph).
//   3. runAction can fire a real action — use view.cleanup which only
//      touches the active canvas (no prompts / file dialogs).

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

try {
  // Auto-accept any native confirm dialogs (file.new gates on
  // confirmDiscardIfDirty when the project is dirty).
  page.on('dialog', (d) => { void d.accept(); });

  await page.goto(`${server.url}?debug=1&scene=basic`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 15000 });
  await page.waitForFunction(() => typeof window.sedonMcp === 'object', { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 2500));

  const mcpView = await page.evaluate(async () => {
    const mcp = window.sedonMcp;
    const toolNames = mcp.tools.map((t) => t.name);
    const list = await mcp.call('listActions', {});
    return {
      hasListActions: toolNames.includes('listActions'),
      hasRunAction: toolNames.includes('runAction'),
      toolCount: toolNames.length,
      sampleActionIds: list.actions.slice(0, 5).map((a) => a.id),
      totalActions: list.actions.length,
      hasNewSubgraph: list.actions.some((a) => a.id === 'add.new-subgraph'),
      hasFileNew: list.actions.some((a) => a.id === 'file.new'),
      hasViewCleanup: list.actions.some((a) => a.id === 'view.cleanup'),
    };
  });
  console.log('MCP surface:', JSON.stringify(mcpView, null, 2));

  // Fire a runAction and verify it does something observable.
  // file.new is the easiest verifiable side effect: clears the
  // graph back to the basic scene.
  const beforeAfter = await page.evaluate(async () => {
    // Make the project not dirty so confirmDiscardIfDirty doesn't
    // pop window.confirm.
    window.__sedonStore__.getState().markClean();
    // Mutate something so we can detect the reset.
    window.__sedonStore__.getState().setInputValue(
      window.__sedonStore__.getState().graph.nodes[0]?.id ?? '',
      'fg',
      [1, 0, 0, 1],
      { coalesce: false },
    );
    const before = window.__sedonStore__.getState().undoStack.length;
    await window.sedonMcp.call('runAction', { id: 'file.new' });
    const after = window.__sedonStore__.getState().undoStack.length;
    return { before, after };
  });
  console.log('file.new via runAction:', JSON.stringify(beforeAfter));

  // Also test the error paths.
  const errorPaths = await page.evaluate(async () => {
    const errs = {};
    try {
      await window.sedonMcp.call('runAction', { id: 'bogus.does-not-exist' });
      errs.unknown = 'no error thrown';
    } catch (e) {
      errs.unknown = String(e?.message ?? e);
    }
    // After the reset above, undo stack is empty → edit.undo is disabled.
    try {
      await window.sedonMcp.call('runAction', { id: 'edit.undo' });
      errs.disabled = 'no error thrown';
    } catch (e) {
      errs.disabled = String(e?.message ?? e);
    }
    return errs;
  });
  console.log('error paths:', JSON.stringify(errorPaths, null, 2));

  const checks = [
    ['listActions tool exists', mcpView.hasListActions],
    ['runAction tool exists', mcpView.hasRunAction],
    ['add.new-subgraph in registry', mcpView.hasNewSubgraph],
    ['file.new in registry', mcpView.hasFileNew],
    ['view.cleanup in registry', mcpView.hasViewCleanup],
    ['runAction("file.new") cleared undo stack', beforeAfter.after === 0],
    ['unknown id rejected', /no action with id "bogus/.test(errorPaths.unknown)],
    ['disabled id rejected', /currently disabled/.test(errorPaths.disabled)],
  ];
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
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
