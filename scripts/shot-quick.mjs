import puppeteer from 'puppeteer';
import { startDevServer } from './lib/dev-server.mjs';

const server = await startDevServer({ prod: false });
const browser = await puppeteer.launch({
  headless: 'new',
  defaultViewport: { width: 1400, height: 900 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => { errors.push(`[pageerror] ${e.message}`); console.error('PAGEERROR:', e.message); });
page.on('console', (msg) => {
  if (msg.type() === 'error') { errors.push(`[err] ${msg.text()}`); console.error('CONSOLE-ERR:', msg.text()); }
});

await page.goto(`${server.url}?debug=1&scene=city`, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => typeof window.__sedonStore__ === 'function', { timeout: 30000 });
// Long wait for initial eval to settle.
await new Promise((r) => setTimeout(r, 45000));

console.log('Errors observed:', errors.length);
errors.forEach((e) => console.log(' ', e));

try {
  await page.screenshot({ path: '/tmp/city-quick.png', timeout: 120000 });
  console.log('shot: /tmp/city-quick.png');
} catch (e) {
  console.error('Screenshot failed:', e.message);
}

await browser.close();
await server.stop();
