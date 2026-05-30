import type { NodeDef } from '../core/node-def.js';
import { docsUrlFor } from './doc-paths.js';

interface DocsIndexProps {
  defs: NodeDef[];
}

// Documentation TOC. Groups documented node defs by category and
// renders a category → list-of-links tree. Linked from the editor's
// Help menu.
export function DocsIndex({ defs }: DocsIndexProps) {
  const documented = defs.filter((d) => d.doc);
  const byCategory = new Map<string, NodeDef[]>();
  for (const def of documented) {
    const list = byCategory.get(def.category) ?? [];
    list.push(def);
    byCategory.set(def.category, list);
  }
  const categories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="sedon-doc-shell">
      <header className="sedon-doc-header">
        <span className="sedon-doc-breadcrumb">Sedon documentation</span>
      </header>

      <main className="sedon-doc-main">
        <h1 className="sedon-doc-title">Node reference</h1>
        {categories.length === 0 ? (
          <div className="sedon-doc-muted">No nodes have documentation yet.</div>
        ) : (
          categories.map(([category, list]) => (
            <section key={category} className="sedon-doc-section">
              <h2 className="sedon-doc-h2">{category}</h2>
              <ul className="sedon-doc-list">
                {list
                  .sort((a, b) => a.id.localeCompare(b.id))
                  .map((def) => (
                    <li key={def.id}>
                      <a href={docsUrlFor(def.id, 'docs-index', 'index')}>
                        <code>{def.id}</code>
                      </a>
                      {def.doc?.summary && (
                        <span className="sedon-doc-list-summary">— {def.doc.summary}</span>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
