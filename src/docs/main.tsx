import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { useEditorStore } from '../editor/store.js';
import { DocsIndex } from './docs-index.js';
import { DocsPage } from './docs-page.js';
// editor.css ships the CustomNode + ReactFlow handle styles the
// sample-graph embed depends on. Docs-specific overrides come last so
// they take precedence on shared selectors.
import '../editor/editor.css';
import './docs.css';

// Docs entry point. The generated HTML pages inline a small config
// block as `<script id="sedon-doc-config" type="application/json">…</script>`
// telling us which mode to render:
//
//   { "kind": "node", "nodeId": "core/perlin" }   → DocsPage
//   { "kind": "index" }                            → DocsIndex
//
// The same bundle serves both — the per-node and TOC pages all link to
// `/dist/docs.js`, and the inline config switches mode. Saves a build
// step (one bundle, N HTML shells) and keeps the registry walk that
// powers the TOC in one place.

interface DocConfig {
  kind: 'node' | 'index';
  nodeId?: string;
  /**
   * Pre-rendered HTML body for the node's description, produced at
   * build time by showdown so the runtime doesn't have to ship a
   * markdown parser. Empty string when the node had no description.
   */
  descriptionHtml?: string;
}

function readConfig(): DocConfig {
  const node = document.getElementById('sedon-doc-config');
  if (!node) return { kind: 'index' };
  try {
    return JSON.parse(node.textContent ?? '{}') as DocConfig;
  } catch {
    return { kind: 'index' };
  }
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found in docs page');
}

const config = readConfig();
const registry = createCoreNodeRegistry();
const defs = registry.list();

const reactRoot = createRoot(root);

if (config.kind === 'node' && config.nodeId) {
  const def = registry.get(config.nodeId);
  if (!def) {
    reactRoot.render(
      <div className="sedon-doc-shell">
        <div className="sedon-doc-empty">
          Unknown node id: <code>{config.nodeId}</code>
        </div>
      </div>,
    );
  } else {
    // Seed the editor store with the sample graph BEFORE rendering so
    // CustomNode's value-editing path lands in the right place from the
    // first render. setInputValue (and every other in-canvas mutation)
    // routes through routeBack(), which checks `currentEditingId` and
    // writes to `mainGraph` when it's 'main'. So:
    //   • mainGraph + mainRootNodeId = our sample graph
    //   • graph + rootNodeId = same (we're "editing main")
    //   • currentEditingId = 'main'
    //   • clear nodePositions so auto-layout owns positioning from the
    //     start (no flash of authored positions before layout runs)
    //   • clear undo/redo so leftover history from any imagined prior
    //     project state doesn't surface on a freshly-loaded doc page
    const sample = def.doc?.sampleGraph?.();
    if (sample) {
      useEditorStore.setState({
        graph: sample.graph,
        rootNodeId: sample.rootNodeId,
        mainGraph: sample.graph,
        mainRootNodeId: sample.rootNodeId,
        currentEditingId: 'main',
        nodePositions: { main: {} },
        undoStack: [],
        redoStack: [],
      });
    }
    reactRoot.render(
      <StrictMode>
        <DocsPage def={def} descriptionHtml={config.descriptionHtml ?? ''} />
      </StrictMode>,
    );
  }
} else {
  reactRoot.render(
    <StrictMode>
      <DocsIndex defs={defs} />
    </StrictMode>,
  );
}
