import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1600, height: 1000 },
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE-ERR:', m.text()); });

await page.goto(`${server.url}?debug=1&scene=single-building`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(
  () => typeof window.__sedonStore__ !== 'undefined' && window.__sedonStore__.getState().graph.nodes.length > 0,
  { timeout: 15000 },
);
await new Promise((r) => setTimeout(r, 5000));

const diag = await page.evaluate(() => {
  const s = window.__sedonStore__.getState();
  const panels = window.__sedonListPanelIds__?.() ?? [];
  for (const p of panels) {
    const out = window.__sedonGetOutputs__(p, s.rootNodeId);
    if (out && out.scene) {
      const ents = out.scene.entities ?? [];
      const tinted = ents.filter((e) => {
        const t = e.tint;
        return t && (Math.abs(t[0] - 1) > 0.01 || Math.abs(t[1] - 1) > 0.01 || Math.abs(t[2] - 1) > 0.01);
      });
      return {
        total: ents.length,
        tinted: tinted.length,
        sigs: tinted.map((e) => ({
          x: +e.transform[12].toFixed(1),
          y: +e.transform[13].toFixed(1),
          z: +e.transform[14].toFixed(1),
          tint: [+e.tint[0].toFixed(2), +e.tint[1].toFixed(2), +e.tint[2].toFixed(2)],
        })),
      };
    }
  }
  return {};
});
console.log('diag:', JSON.stringify(diag));

const box = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('canvas'));
  let best = null, bestA = 0;
  for (const c of all) {
    const r = c.getBoundingClientRect();
    const a = r.width * r.height;
    if (a > bestA) { bestA = a; best = { x: r.x, y: r.y, w: r.width, h: r.height }; }
  }
  return best;
});
await page.screenshot({ path: '/tmp/modular-office.png', clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
console.log('→ /tmp/modular-office.png');

await browser.close();
await server.stop();
console.log('OK');
