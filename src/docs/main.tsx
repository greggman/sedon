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
//   { "kind": "node", "nodeId": "tex/perlin" }   → DocsPage
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
  /**
   * Pre-rendered HTML for each input's `description`, keyed by input
   * name. Build time runs each through showdown and strips the outer
   * `<p>` wrapper for the common single-paragraph case so table cells
   * stay compact. Missing entries / empty strings render as "no
   * description" in the docs page.
   */
  inputDescriptionsHtml?: Record<string, string>;
  outputDescriptionsHtml?: Record<string, string>;
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

// Match the editor entry's `?debug=1` posture: expose the store +
// canvas-data so headless repros can inspect the rendered sample on
// each per-node docs page. Useful for verifying that a node's
// `doc.sampleGraph` evaluates correctly in the docs context (the
// editor demo path is a different mount; bugs can show up here that
// don't surface there).
if (new URLSearchParams(window.location.search).get('debug') === '1') {
  (window as unknown as { __sedonStore__: typeof useEditorStore }).__sedonStore__ = useEditorStore;
  void import('../editor/canvas-data.js').then((m) => {
    (window as unknown as {
      __sedonGetOutputs__: typeof m.debugGetOutputs;
      __sedonListPanelIds__: typeof m.debugListPanelIds;
    }).__sedonGetOutputs__ = m.debugGetOutputs;
    (window as unknown as {
      __sedonGetOutputs__: typeof m.debugGetOutputs;
      __sedonListPanelIds__: typeof m.debugListPanelIds;
    }).__sedonListPanelIds__ = m.debugListPanelIds;
  });
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
        // Samples that reference subgraph wrapper kinds (e.g.
        // iter/for-each-point's body) provide them here; the editor
        // store's `subgraphs` slice feeds the registry build, so the
        // wrapper kind is in the registry by the time the sample
        // evaluates.
        ...(sample.subgraphs ? { subgraphs: sample.subgraphs } : {}),
        currentEditingId: 'main',
        nodePositions: { main: {} },
        undoStack: [],
        redoStack: [],
      });
    }
    reactRoot.render(
      <StrictMode>
        <DocsPage
          def={def}
          descriptionHtml={config.descriptionHtml ?? ''}
          inputDescriptionsHtml={config.inputDescriptionsHtml ?? {}}
          outputDescriptionsHtml={config.outputDescriptionsHtml ?? {}}
          defs={defs}
        />
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
