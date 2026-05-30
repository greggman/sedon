import type { InputDef, NodeDef, OutputDef } from '../core/node-def.js';
import { docsIndexUrl, docsUrlFor } from './doc-paths.js';
import { DocsSamplePreview } from './docs-sample-preview.js';

// Single-node documentation page. The build script (scripts/build.mjs)
// runs each node's `doc.description` markdown through showdown at
// build time and embeds the resulting HTML in the page's inline
// `<script id="sedon-doc-config">` block; that HTML arrives here as
// the `descriptionHtml` prop and gets stuffed straight into the DOM
// via `dangerouslySetInnerHTML`. Doing the markdown render at build
// time keeps showdown out of the runtime bundle and lets cross-node
// links (`[core/blend](../../core/blend)`) become real `<a>` tags
// before the page even loads.

interface DocsPageProps {
  def: NodeDef;
  descriptionHtml: string;
  /**
   * Pre-rendered HTML for each input / output description, keyed by
   * name. Build-time showdown pass; empty / missing entries fall back
   * to a muted "no description" placeholder.
   */
  inputDescriptionsHtml: Record<string, string>;
  outputDescriptionsHtml: Record<string, string>;
  /**
   * Every node def the registry knows about — used by the bottom-of-
   * page "All nodes" mini-TOC so users can jump category-to-category
   * without scrolling back to the main index. Same list main.tsx
   * passes to DocsIndex.
   */
  defs: NodeDef[];
}

function formatDefault(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatDefault).join(', ')}]`;
  return JSON.stringify(value);
}

// Small swatch shown next to a Color default value in the table.
// Colors are authored as [r, g, b, a] in [0, 1] linear-ish sRGB; we
// just clamp + multiply by 255 to render. Alpha sits over the same
// checkerboard the editor uses so transparent colours read as
// transparent. Returns null when the value isn't a length-4 numeric
// array (defensive — the type system already guarantees this for
// well-formed NodeDefs, but a doc author with a typo shouldn't crash
// the page).
function ColorSwatch({ value }: { value: unknown }): React.JSX.Element | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [r, g, b, a] = value as number[];
  if (
    typeof r !== 'number' || typeof g !== 'number'
    || typeof b !== 'number' || typeof a !== 'number'
  ) return null;
  const byte = (c: number) => Math.max(0, Math.min(255, Math.round(c * 255)));
  const css = `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${a})`;
  // Two stacked elements: outer shows the checkerboard, inner
  // overlays the authored colour. CSS `background-image` always
  // paints on top of `background-color`, so a single-element swatch
  // with both would hide the checker behind the colour even for
  // fully-transparent alpha. Same pattern the editor's
  // `.sedon-color-current-swatch` + `.sedon-color-current-fill` uses.
  return (
    <span className="sedon-doc-color-swatch" aria-hidden>
      <span className="sedon-doc-color-swatch-fill" style={{ background: css }} />
    </span>
  );
}

function InputRow({ input, descriptionHtml }: { input: InputDef; descriptionHtml: string }) {
  const isColor = input.type === 'Color';
  return (
    <tr>
      <td className="sedon-doc-cell-name">{input.label ?? input.name}</td>
      <td className="sedon-doc-cell-type">{input.type}</td>
      <td className="sedon-doc-cell-default">
        {isColor && <ColorSwatch value={input.default} />}
        {formatDefault(input.default)}
      </td>
      <td className="sedon-doc-cell-desc">
        {descriptionHtml
          ? <span dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          : <span className="sedon-doc-muted">no description</span>}
        {input.enumOptions && (
          <ul className="sedon-doc-enum">
            {input.enumOptions.map((o) => (
              <li key={o.value}>
                <code>{o.value}</code> — {o.label}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function OutputRow({ output, descriptionHtml }: { output: OutputDef; descriptionHtml: string }) {
  return (
    <tr>
      <td className="sedon-doc-cell-name">{output.label ?? output.name}</td>
      <td className="sedon-doc-cell-type">{output.type}</td>
      <td className="sedon-doc-cell-desc">
        {descriptionHtml
          ? <span dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          : <span className="sedon-doc-muted">no description</span>}
      </td>
    </tr>
  );
}

// Compact bottom-of-page mini-TOC. Categories laid out in a responsive
// grid of 300 px columns, each listing its nodes by id only (no
// summaries — the main /docs/ index has those). Lets a reader jump
// laterally to any other node from inside any node's page.
function BottomTOC({ defs, currentId }: { defs: NodeDef[]; currentId: string }) {
  const documented = defs.filter((d) => d.doc);
  const byCategory = new Map<string, NodeDef[]>();
  for (const d of documented) {
    const list = byCategory.get(d.category) ?? [];
    list.push(d);
    byCategory.set(d.category, list);
  }
  const categories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  return (
    <section className="sedon-doc-section sedon-doc-bottom-toc">
      <h2 className="sedon-doc-h2">All nodes</h2>
      <div className="sedon-doc-bottom-toc-grid">
        {categories.map(([category, list]) => (
          <div key={category} className="sedon-doc-bottom-toc-col">
            <h3 className="sedon-doc-bottom-toc-cat">{category}</h3>
            <ul className="sedon-doc-bottom-toc-list">
              {list
                .slice()
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((d) => (
                  <li
                    key={d.id}
                    className={d.id === currentId ? 'sedon-doc-bottom-toc-current' : ''}
                  >
                    {d.id === currentId ? (
                      <code>{d.id}</code>
                    ) : (
                      <a href={docsUrlFor(d.id, { kind: 'docs-node', id: currentId }, 'index')}>
                        <code>{d.id}</code>
                      </a>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

export function DocsPage({ def, descriptionHtml, inputDescriptionsHtml, outputDescriptionsHtml, defs }: DocsPageProps) {
  const doc = def.doc;
  if (!doc) {
    return (
      <div className="sedon-doc-shell">
        <div className="sedon-doc-empty">No documentation for <code>{def.id}</code>.</div>
      </div>
    );
  }

  const sampleGraph = doc.sampleGraph?.();

  return (
    <div className="sedon-doc-shell">
      <header className="sedon-doc-header">
        <a
          href={docsIndexUrl({ kind: 'docs-node', id: def.id })}
          className="sedon-doc-breadcrumb"
        >← Sedon documentation</a>
      </header>

      <main className="sedon-doc-main">
        <div className="sedon-doc-title-row">
          <h1 className="sedon-doc-title">{def.id}</h1>
          <span className="sedon-doc-category">{def.category}</span>
        </div>

        <p className="sedon-doc-summary">{doc.summary}</p>

        {descriptionHtml && (
          <section
            className="sedon-doc-section sedon-doc-description"
            // Pre-rendered HTML from the build-time showdown pass. The
            // markdown source is authored by us (in the NodeDef.doc.
            // description fields) so there's no untrusted input here.
            dangerouslySetInnerHTML={{ __html: descriptionHtml }}
          />
        )}

        <section className="sedon-doc-section sedon-doc-section--wide">
          {sampleGraph ? (
            <DocsSamplePreview sampleGraph={sampleGraph} hostNodeId={def.id} />
          ) : (
            <div className="sedon-doc-muted">No sample graph provided.</div>
          )}
        </section>

        <section className="sedon-doc-section">
          <h2 className="sedon-doc-h2">Inputs</h2>
          {def.inputs.length === 0 ? (
            <div className="sedon-doc-muted">no inputs</div>
          ) : (
            <table className="sedon-doc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Default</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {def.inputs.map((i) => (
                  <InputRow key={i.name} input={i} descriptionHtml={inputDescriptionsHtml[i.name] ?? ''} />
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="sedon-doc-section">
          <h2 className="sedon-doc-h2">Outputs</h2>
          {def.outputs.length === 0 ? (
            <div className="sedon-doc-muted">no outputs</div>
          ) : (
            <table className="sedon-doc-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {def.outputs.map((o) => (
                  <OutputRow key={o.name} output={o} descriptionHtml={outputDescriptionsHtml[o.name] ?? ''} />
                ))}
              </tbody>
            </table>
          )}
        </section>

        <BottomTOC defs={defs} currentId={def.id} />
      </main>
    </div>
  );
}
