import * as esbuild from 'esbuild';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

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

const sharedOptions = {
  bundle: true,
  outdir: 'dist',
  // The `file` loader emits assets into outdir (dist/) and rewrites the
  // import to a URL. Without publicPath that URL is relative to the
  // OUTPUT FILE, so it comes back as "./icon-XXXX.svg" — which the
  // browser resolves against index.html (served at "/"), fetching
  // "/icon-XXXX.svg" and 404ing because the file is really at
  // "/dist/icon-XXXX.svg". publicPath prefixes the emitted URLs so they
  // point at where the files actually land. index.html loads
  // ./dist/main.js, so dist is served at /dist.
  publicPath: 'dist',
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

// Editor app — what index.html loads.
const editorOptions = {
  ...sharedOptions,
  entryPoints: ['src/main.tsx'],
};

// Docs site bundle. Shares the same registry walk as the editor (so
// authoring a node automatically makes it available to docs), and gets
// emitted alongside the editor's bundle. The static HTML pages that
// link to dist/docs.js are written by `writeDocsHtml` below.
const docsOptions = {
  ...sharedOptions,
  entryPoints: ['src/docs/main.tsx'],
};

// Walk the runtime node registry to find which kinds carry a
// `doc` field, and emit one static page per documented kind. The walk
// happens in a one-shot Node sub-process by bundling a small probe
// against the same source the editor uses, so there's no manual list
// to keep in sync — adding `doc: {...}` to a NodeDef immediately gets
// it a page on the next build.
//
// The probe writes its result to a temp file and exits; we
// dynamic-import that file to read the list. We use a written-file
// path rather than evaluating the string directly because (a) Node's
// dynamic import handles ESM properly without us needing to set up a
// VM context, and (b) the bundled module may use top-level await
// and other ESM-only constructs that a Function constructor can't run.
async function listDocumentedNodeIds() {
  // The probe imports through src/nodes/index.ts. Using the project's
  // own `.js`-suffixed import style (matches editor source); esbuild
  // resolves it via resolveDir + the bundler's TS resolution rules.
  const probeSource = `
    import { CORE_NODES } from './src/nodes/index.js';
    export const ids = CORE_NODES.filter((n) => n.doc).map((n) => n.id);
  `;
  const result = await esbuild.build({
    stdin: { contents: probeSource, loader: 'ts', resolveDir: process.cwd() },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'error',
    loader: { '.wgsl': 'text' },
  });
  const tmp = path.join(os.tmpdir(), `sedon-docs-probe-${process.pid}-${Date.now()}.mjs`);
  await writeFile(tmp, result.outputFiles[0].text, 'utf8');
  try {
    const mod = await import(pathToFileURL(tmp).href);
    return /** @type {string[]} */ (mod.ids);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

// `depthToRoot` is the relative path from the page back to the repo
// root (`../`, `../../../`, …). The docs entry bundles to
// `dist/docs/main.{js,css}` — esbuild preserves the relative path
// from the shared entry-point ancestor (src/) so the `docs/` subdir
// makes it into the output tree.
const HTML_TEMPLATE = (title, configJson, depthToRoot) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="${depthToRoot}dist/docs/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script id="sedon-doc-config" type="application/json">${configJson}</script>
    <script type="module" src="${depthToRoot}dist/docs/main.js"></script>
  </body>
</html>
`;

// Generate `docs/index.html` (TOC) and `docs/nodes/<id>/index.html`
// for every node whose NodeDef carries a `doc` field. The list comes
// from `listDocumentedNodeIds()` above (which walks the same registry
// the editor uses), so it's always in sync with the source.
async function writeDocsHtml() {
  const documentedIds = await listDocumentedNodeIds();

  // TOC at /docs/index.html — one directory up to reach the repo root.
  const tocConfig = JSON.stringify({ kind: 'index' });
  await mkdir('docs', { recursive: true });
  await writeFile(
    'docs/index.html',
    HTML_TEMPLATE('Sedon documentation', tocConfig, '../'),
    'utf8',
  );

  // Per-node pages at /docs/nodes/<id>/index.html. The id segments
  // become directories: depth = 2 (docs/ + nodes/) + segment count.
  for (const id of documentedIds) {
    const dir = path.join('docs', 'nodes', ...id.split('/'));
    await mkdir(dir, { recursive: true });
    const depth = 2 + id.split('/').length;
    const depthToRoot = '../'.repeat(depth);
    const config = JSON.stringify({ kind: 'node', nodeId: id });
    await writeFile(
      path.join(dir, 'index.html'),
      HTML_TEMPLATE(`${id} — Sedon docs`, config, depthToRoot),
      'utf8',
    );
  }
  console.log(`Docs HTML written: 1 TOC + ${documentedIds.length} node page(s)`);
}

if (serve) {
  const ctx = await esbuild.context({
    ...editorOptions,
    entryPoints: [...editorOptions.entryPoints, ...docsOptions.entryPoints],
  });
  await ctx.watch();
  const port = await findFreePort(8080);
  const result = await ctx.serve({ servedir: '.', port });
  const host = result.host === '0.0.0.0' ? 'localhost' : result.host;
  const mode = prod ? 'PRODUCTION React (no dev warnings)' : 'development React';
  console.log(`\nSedon dev server: http://${host}:${result.port}/  [${mode}]\n`);
  await writeDocsHtml();
} else {
  await esbuild.build({
    ...editorOptions,
    entryPoints: [...editorOptions.entryPoints, ...docsOptions.entryPoints],
  });
  await writeDocsHtml();
  console.log('Build complete: dist/main.js, dist/docs.js');
}
