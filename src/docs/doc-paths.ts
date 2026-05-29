// Shared URL helpers so the build script, the docs pages, and the
// editor's [?] icon all agree on where things live.
//
// All paths are absolute from the site root. The dev server (npm run
// serve) serves the repo at `/`, so the docs sit at `/docs/...`; the
// same paths work in any static deploy that keeps that root.

export const DOCS_BASE = '/docs';

/**
 * URL for a single node's docs page. `target` selects whether to point
 * at the page itself (`'self'`) or the page's `index.html` (`'index'`)
 * — both resolve identically in a browser but `index` is useful when
 * a static-site link checker doesn't follow directory redirects.
 *
 * Node ids contain `/` (e.g. `core/perlin`). We preserve the slash as
 * a real subdirectory split so each segment is its own folder. That
 * keeps URLs human-readable and lets search engines index by category.
 */
export function docsUrlFor(id: string, target: 'self' | 'index' = 'self'): string {
  const dir = `${DOCS_BASE}/nodes/${id}/`;
  return target === 'index' ? `${dir}index.html` : dir;
}

/** URL for the documentation table-of-contents (Sedon docs root). */
export function docsIndexUrl(target: 'self' | 'index' = 'self'): string {
  return target === 'index' ? `${DOCS_BASE}/index.html` : `${DOCS_BASE}/`;
}
