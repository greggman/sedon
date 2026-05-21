import * as esbuild from 'esbuild';
import * as net from 'node:net';
import { argv } from 'node:process';

const serve = argv.includes('--serve');
// `--prod` swaps the React build to its production bundle by inlining
// `process.env.NODE_ENV` at bundle time. Skips the dev-only validation
// (`validatePropertiesInDevelopment`, `warnUnknownProperties`,
// `logComponentRender`, `runWithFiberInDEV`) — measured at ~50% of CPU
// per drag tick in DevTools profiling, so the speed-up is dramatic.
// Loses React DevTools support and helpful dev warnings; only flip it
// when chasing perf.
const prod = argv.includes('--prod');

// Try to listen on `port`. If it's busy, try the next one. esbuild's serve()
// rejects on a busy port instead of falling through, so we pre-resolve it.
function findFreePort(port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(findFreePort(port + 1, host));
      } else {
        reject(err);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(port));
    });
    server.listen({ port, host, exclusive: true });
  });
}

const options = {
  entryPoints: ['src/main.tsx'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  loader: {
    '.wgsl': 'text',
    '.png': 'file',
    '.jpg': 'file',
    '.svg': 'file',
    '.mp4': 'file',
    '.mp3': 'file',
  },
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
  },
  ...(prod ? { minify: true } : {}),
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const port = await findFreePort(8080);
  const result = await ctx.serve({ servedir: '.', port });
  const host = result.host === '0.0.0.0' ? 'localhost' : result.host;
  const mode = prod ? 'PRODUCTION React (no dev warnings)' : 'development React';
  console.log(`\nSedon dev server: http://${host}:${result.port}/  [${mode}]\n`);
} else {
  await esbuild.build(options);
  console.log('Build complete: dist/main.js');
}
