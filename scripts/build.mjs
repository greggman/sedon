import * as esbuild from 'esbuild';
import * as net from 'node:net';
import { argv } from 'node:process';

const serve = argv.includes('--serve');

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
  entryPoints: ['src/main.ts'],
  bundle: true,
  outfile: 'dist/main.js',
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  loader: { '.wgsl': 'text' },
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const port = await findFreePort(8080);
  const result = await ctx.serve({ servedir: '.', port });
  const host = result.host === '0.0.0.0' ? 'localhost' : result.host;
  console.log(`\nSedon dev server: http://${host}:${result.port}/\n`);
} else {
  await esbuild.build(options);
  console.log('Build complete: dist/main.js');
}
