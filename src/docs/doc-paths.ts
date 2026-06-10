// Shared URL helpers so the build script, the docs pages, and the
// editor's [?] icon all agree on where things live.
//
// Every helper returns a path that's RELATIVE to the page that's calling
// it. That keeps the docs portable: drop the `docs/` directory anywhere
// in any static deploy (mysite.com/docs/, mysite.com/sedon-docs/,
// project/wiki/v2/docs/, …) and the cross-page links keep working
// because they never assume site-root.
//
// Callers pass a `from` describing where they're rendering:
//   • 'site-root'        — at the deploy root, e.g. /index.html (editor)
//   • 'docs-index'       — at docs/index.html (the TOC)
//   • { kind: 'docs-node', id } — at docs/nodes/<id>/index.html (a node page)
// The helper then walks `../` the right number of times to land at the
// docs root, then descends to the target.

export type DocsCallerLocation =
  | 'site-root'
  | 'docs-index'
  | { kind: 'docs-node'; id: string };

// Relative path from the calling page's directory to the docs/ root
// (always trailing-slashed). Node ids are split by '/' to count
// directory levels: id `tex/perlin` lives at docs/nodes/tex/perlin/,
// so we need `../` × (segments + 1) to climb back to docs/.
function docsRootRelativePrefix(from: DocsCallerLocation): string {
  if (from === 'site-root') return 'docs/';
  if (from === 'docs-index') return './';
  return '../'.repeat(from.id.split('/').length + 1);
}

/**
 * URL for a single node's docs page, relative to the caller. `target`
 * selects whether to point at the page itself (`'self'`) or the page's
 * `index.html` (`'index'`) — both resolve identically in a browser but
 * `index` is useful when a static-site link checker doesn't follow
 * directory redirects.
 *
 * Node ids contain `/` (e.g. `tex/perlin`). We preserve the slash as
 * a real subdirectory split so each segment is its own folder.
 */
export function docsUrlFor(
  id: string,
  from: DocsCallerLocation = 'site-root',
  target: 'self' | 'index' = 'self',
): string {
  const prefix = docsRootRelativePrefix(from);
  const dir = `${prefix}nodes/${id}/`;
  return target === 'index' ? `${dir}index.html` : dir;
}

/** URL for the documentation table-of-contents (Sedon docs root). */
export function docsIndexUrl(
  from: DocsCallerLocation = 'site-root',
  target: 'self' | 'index' = 'self',
): string {
  const prefix = docsRootRelativePrefix(from);
  return target === 'index' ? `${prefix}index.html` : prefix;
}
