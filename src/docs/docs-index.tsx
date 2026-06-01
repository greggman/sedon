import type React from 'react';
import type { NodeDef } from '../core/node-def.js';
import { docsUrlFor } from './doc-paths.js';

interface DocsIndexProps {
  defs: NodeDef[];
}

// Documentation TOC. Three tables of contents stacked vertically:
//   1. By category — the primary index, mirrors the Add menu.
//   2. By output type — every node that produces a given socket
//      type, with the socket names it produces of that type.
//   3. By input type — every node that consumes a given socket
//      type, with the socket names it consumes.
//
// A node appears in (2) and (3) once per distinct type its outputs /
// inputs cover, so a node with outputs `Geometry + Scene` shows up
// in both the Geometry section and the Scene section. Hidden inputs
// (e.g. `__bridgeId` on for-each-point — internal plumbing the user
// doesn't wire) are filtered out of the input table.
export function DocsIndex({ defs }: DocsIndexProps) {
  const documented = defs.filter((d) => d.doc);
  const byCategory = new Map<string, NodeDef[]>();
  for (const def of documented) {
    const list = byCategory.get(def.category) ?? [];
    list.push(def);
    byCategory.set(def.category, list);
  }
  const categories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Build the type-keyed tables. Same node may appear under multiple
  // types, but only ONCE per type (a node with two `Float` outputs
  // shows up once under Float with both socket names listed).
  interface TypeRow { def: NodeDef; sockets: string[] }
  function groupByType(
    pickSockets: (d: NodeDef) => ReadonlyArray<{ name: string; type: string }>,
  ): Map<string, TypeRow[]> {
    const map = new Map<string, Map<string, TypeRow>>();
    for (const def of documented) {
      const seenForDef = new Map<string, TypeRow>();
      for (const s of pickSockets(def)) {
        let row = seenForDef.get(s.type);
        if (!row) {
          row = { def, sockets: [] };
          seenForDef.set(s.type, row);
        }
        row.sockets.push(s.name);
      }
      for (const [type, row] of seenForDef) {
        let typeMap = map.get(type);
        if (!typeMap) { typeMap = new Map(); map.set(type, typeMap); }
        typeMap.set(def.id, row);
      }
    }
    const out = new Map<string, TypeRow[]>();
    for (const [type, defMap] of map) {
      out.set(type, [...defMap.values()].sort((a, b) => a.def.id.localeCompare(b.def.id)));
    }
    return out;
  }

  const byOutputType = groupByType((d) => d.outputs);
  const byInputType = groupByType((d) => d.inputs.filter((i) => !i.hidden));
  const outputTypes = [...byOutputType.entries()].sort(([a], [b]) => a.localeCompare(b));
  const inputTypes = [...byInputType.entries()].sort(([a], [b]) => a.localeCompare(b));

  const renderTypeSection = (type: string, rows: TypeRow[]) => (
    <section key={type} className="sedon-doc-section">
      <h3 className="sedon-doc-h3"><code>{type}</code></h3>
      <ul className="sedon-doc-list">
        {rows.map(({ def, sockets }) => (
          <li key={def.id}>
            <a href={docsUrlFor(def.id, 'docs-index', 'index')}>
              <code>{def.id}</code>
            </a>
            <span className="sedon-doc-list-summary">
              {' — '}
              {sockets.map((s) => <code key={s}>{s}</code>).reduce<React.ReactNode[]>(
                (acc, el, i) => i === 0 ? [el] : [...acc, ', ', el],
                [],
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );

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
          <>
            <h2 className="sedon-doc-h2">By category</h2>
            {categories.map(([category, list]) => (
              <section key={category} className="sedon-doc-section">
                <h3 className="sedon-doc-h3">{category}</h3>
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
            ))}

            <h2 className="sedon-doc-h2">By output type</h2>
            {outputTypes.map(([type, rows]) => renderTypeSection(type, rows))}

            <h2 className="sedon-doc-h2">By input type</h2>
            {inputTypes.map(([type, rows]) => renderTypeSection(type, rows))}
          </>
        )}
      </main>
    </div>
  );
}
