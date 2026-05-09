import * as esbuild from 'esbuild';
import { argv } from 'node:process';

const serve = argv.includes('--serve');

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
  const { host, port } = await ctx.serve({ servedir: '.', port: 8000 });
  console.log(`\nSedon dev server: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/\n`);
} else {
  await esbuild.build(options);
  console.log('Build complete: dist/main.js');
}
