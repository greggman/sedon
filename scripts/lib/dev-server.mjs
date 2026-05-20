// Spawn `node scripts/build.mjs --serve` (dev mode), capture the port
// from its stdout, and hand back { url, stop } so a puppeteer repro
// can drive a server it owns instead of fighting whatever the user
// has running on 8080. Each repro gets its own free port — no
// "address already in use" races, no interference with the user's
// session, and no need for the repro author to hardcode a URL.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildScript = path.resolve(here, '..', 'build.mjs');

export async function startDevServer({ prod = false } = {}) {
  const args = [buildScript, '--serve'];
  if (prod) args.push('--prod');
  const proc = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Wait for the "Sedon dev server: http://..." line on stdout. The
  // build script prints it after `ctx.serve(...)` resolves, so by the
  // time we see it the server is accepting connections.
  let buffer = '';
  let stderr = '';
  let resolved = false;
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const url = await new Promise((resolve, reject) => {
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/http:\/\/[^\s]+/);
      if (m && !resolved) {
        resolved = true;
        resolve(m[0]);
      }
    });
    proc.on('exit', (code) => {
      if (!resolved) reject(new Error(`dev server exited (${code}) before listening; stderr=${stderr}; stdout=${buffer}`));
    });
    proc.on('error', reject);
  });

  return {
    url,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill('SIGTERM');
      await new Promise((r) => proc.on('exit', r));
    },
  };
}
