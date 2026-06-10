import { createRoot } from 'react-dom/client';
import type { GraphNode } from './core/graph.js';
import { App } from './editor/app.js';
import { DEMOS } from './editor/demos/index.js';
import { useEditorStore } from './editor/store.js';
import { decodeProjectFromUrl, getUrlAnim, getUrlJsonParam } from './editor/url-state.js';
import { setImageLoadedListener } from './nodes/image.js';
import 'dockview/dist/styles/dockview.css';
import './editor/editor.css';

// When a `tex/image` node's fetch lands, record the bitmap's natural
// dimensions back into the matching node's hidden inputValues so a
// future graph reload's placeholder texture comes up at the right size
// instead of the 256×256 default. Bypasses dispatchProject so the
// auto-update doesn't show up in the undo stack — undoing the URL
// change separately is the user-visible action.
setImageLoadedListener(({ url, width, height }) => {
  useEditorStore.setState((state) => {
    const updateNodes = (nodes: GraphNode[]): GraphNode[] => {
      let changed = false;
      const next = nodes.map((n) => {
        if (n.kind !== 'tex/image') return n;
        if (n.inputValues?.url !== url) return n;
        const cur = n.inputValues;
        if (cur.width === width && cur.height === height) return n;
        changed = true;
        return { ...n, inputValues: { ...cur, width, height } };
      });
      return changed ? next : nodes;
    };
    const nextMain = { ...state.mainGraph, nodes: updateNodes(state.mainGraph.nodes) };
    const mainChanged = nextMain.nodes !== state.mainGraph.nodes;
    let subgraphsChanged = false;
    const nextSubgraphs = state.subgraphs.map((s) => {
      const nextNodes = updateNodes(s.graph.nodes);
      if (nextNodes === s.graph.nodes) return s;
      subgraphsChanged = true;
      return { ...s, graph: { ...s.graph, nodes: nextNodes } };
    });
    if (!mainChanged && !subgraphsChanged) return {};
    const nextGraph = state.currentEditingId === 'main'
      ? (mainChanged ? nextMain : state.graph)
      : (nextSubgraphs.find((s) => s.id === state.currentEditingId)?.graph ?? state.graph);
    return {
      mainGraph: nextMain,
      subgraphs: nextSubgraphs,
      graph: nextGraph,
    };
  });
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found');
}

// Test/debug hook: when running with `?debug=1`, expose the store + demos
// on window so Puppeteer (or the devtools console) can drive the editor
// without UI clicks. Used to reproduce GPU-pool-churn bugs deterministically.
if (new URLSearchParams(window.location.search).get('debug') === '1') {
  (window as unknown as { __sedonStore__: typeof useEditorStore }).__sedonStore__ = useEditorStore;
  (window as unknown as { __sedonDemos__: typeof DEMOS }).__sedonDemos__ = DEMOS;
  // Layout store exposed so headless repros that simulate the
  // demos-menu / file-load flow can run `resetForNewProject` between
  // setGraph calls. Production UI invokes this through the menu itself.
  void import('./editor/layout-store.js').then((m) => {
    (window as unknown as { __sedonLayoutStore__: typeof m.useLayoutStore }).__sedonLayoutStore__ = m.useLayoutStore;
  });
  // The navigation helpers that the Asset view's double-click and
  // "Open in Preview" buttons call. Exposed so headless repros can
  // exercise the exact same code path as a user click — including
  // panel pinning, which the per-panel preview/canvas selectors
  // listen to.
  void import('./editor/open-graph.js').then((m) => {
    (window as unknown as { __sedonOpenGraphInCanvas__: typeof m.openGraphInCanvas }).__sedonOpenGraphInCanvas__ = m.openGraphInCanvas;
    (window as unknown as { __sedonOpenGraphInPreview__: typeof m.openGraphInPreview }).__sedonOpenGraphInPreview__ = m.openGraphInPreview;
  });
  // Dockview API getter so repros can read panel titles / iterate
  // panels without poking the DOM tab strip.
  void import('./editor/dockview-handle.js').then((m) => {
    (window as unknown as { __sedonGetDockview__: typeof m.getDockviewApi }).__sedonGetDockview__ = m.getDockviewApi;
  });
  // Card-array blit counter — lets headless grass repros assert a colour
  // edit re-copies the array (a WebGPU canvas can't be pixel-diffed).
  void import('./render/grass.js').then((m) => {
    (window as unknown as { __sedonGrassBlits__: typeof m.getGrassBlitCount }).__sedonGrassBlits__ = m.getGrassBlitCount;
  });
  // Render-bus animation toggle — repros that test time-driven
  // effects (water shimmer, grass wind) need to start the play
  // loop the same way clicking the toolbar's play button would.
  // `__sedonForceSerial__` exposes the force-serial counter so
  // regression tests can distinguish "a forced render happened"
  // from "any draw happened" (e.g. picking does GPU readback work
  // that submits regardless of whether the visual selection
  // outline got redrawn).
  void import('./editor/render-bus.js').then((m) => {
    (window as unknown as { __sedonSetAnimating__: typeof m.setAnimating }).__sedonSetAnimating__ = m.setAnimating;
    (window as unknown as { __sedonForceSerial__: typeof m.currentForceSerial }).__sedonForceSerial__ = m.currentForceSerial;
  });
  // Canvas-data getters so headless repros can inspect per-node eval
  // outputs (textures, scenes, …) by node id without going through
  // React. Used for texture-readback diagnostics.
  void import('./editor/canvas-data.js').then((m) => {
    (window as unknown as {
      __sedonGetOutputs__: typeof m.debugGetOutputs;
      __sedonListPanelIds__: typeof m.debugListPanelIds;
    }).__sedonGetOutputs__ = m.debugGetOutputs;
    (window as unknown as {
      __sedonGetOutputs__: typeof m.debugGetOutputs;
      __sedonListPanelIds__: typeof m.debugListPanelIds;
    }).__sedonListPanelIds__ = m.debugListPanelIds;
  });
  // Recording: start / stop / play exposed so headless repros can
  // round-trip a .sedon-rec without going through the menu / file
  // picker. Same paths the menu uses internally.
  void import('./editor/recording.js').then((m) => {
    (window as unknown as {
      __sedonRecording__: {
        start: typeof m.startRecording;
        stop: typeof m.stopRecording;
        play: typeof m.playRecording;
        active: typeof m.recordingActive;
      };
    }).__sedonRecording__ = {
      start: m.startRecording,
      stop: m.stopRecording,
      play: m.playRecording,
      active: m.recordingActive,
    };
  });
}

// Bootstrap from URL before rendering. If `?json=<base64url>` is
// present we async-decode the embedded project and replace the store
// state via `setGraph` — same code path as the Demos menu / file
// load — BEFORE React mounts, so the user never sees a flash of the
// default scene. Failures just log + fall through to the default; a
// broken share link shouldn't lock the user out of the editor.
void (async () => {
  const jsonParam = getUrlJsonParam();
  if (jsonParam) {
    try {
      const file = await decodeProjectFromUrl(jsonParam);
      useEditorStore.getState().setGraph(
        file.project.graph,
        file.project.rootNodeId,
        file.project.subgraphs,
        file.project.cameras,
        file.project.viewports,
        file.project.folders,
      );
    } catch (e) {
      console.error('Failed to load project from URL:', e);
    }
  } else {
    // No ?json=… override. Demos used to be baked into the bundle and
    // initialized synchronously in createInitialGraph; now they live as
    // fetched .sedon files, so we kick off the load here BEFORE mount.
    // The store starts with the basic scene (set synchronously) and
    // gets overwritten once the .sedon file lands — a one-frame flash
    // is possible but we still mount only once. Failures fall through
    // and the user sees the basic scene.
    const { getPostMountSceneToLoad } = await import('./editor/initial-graph.js');
    const sceneId = getPostMountSceneToLoad();
    if (sceneId) {
      try {
        const { loadDemoSaveFile } = await import('./editor/demos/demo-loader.js');
        const file = await loadDemoSaveFile(sceneId);
        useEditorStore.getState().setGraph(
          file.project.graph,
          file.project.rootNodeId,
          file.project.subgraphs ?? [],
          file.project.cameras,
          file.project.viewports,
          file.project.folders,
        );
      } catch (e) {
        console.error(`Failed to load default demo "${sceneId}":`, e);
      }
    }
  }
  // `?anim=true` — start the render-bus animation loop on boot. Done
  // AFTER any URL-project load (so the loaded scene gets animated
  // rather than the default), and BEFORE mount (so the first render
  // already runs in playing mode). Loaded lazily to keep the
  // bootstrap surface small.
  if (getUrlAnim()) {
    const { setAnimating } = await import('./editor/render-bus.js');
    setAnimating(true);
  }
  // Register the MCP tool surface so a browser-side agent (or any
  // userland script via `window.sedonMcp`) can drive the editor.
  // Done lazily to keep the bootstrap surface small; failures are
  // logged but don't block rendering.
  try {
    const { buildSedonTools } = await import('./editor/mcp/tools.js');
    const { registerSedonTools } = await import('./editor/mcp/webmcp.js');
    const { buildRegistry } = await import('./editor/registry.js');
    const { buildActions } = await import('./editor/actions.js');
    const { recordingActive } = await import('./editor/recording.js');
    const macrosAllowed = new URLSearchParams(window.location.search).get('allow-macros') === '1';
    const tools = buildSedonTools({
      getState: () => useEditorStore.getState(),
      // Registry is per-render in the editor; the MCP surface
      // rebuilds it on every call so user-authored subgraphs added
      // mid-session are immediately visible to the agent.
      getRegistry: () => buildRegistry(useEditorStore.getState().subgraphs),
      // Same per-call freshness for the action registry: undo/redo
      // enabledness, recording state, and the Add: subgraph/<id>
      // entries all track live store state.
      getActions: () => {
        const state = useEditorStore.getState();
        return buildActions({
          registry: buildRegistry(state.subgraphs),
          undoLen: state.undoStack.length,
          redoLen: state.redoStack.length,
          recording: recordingActive(),
          macrosAllowed,
        });
      },
    });
    const status = registerSedonTools(tools);
    // eslint-disable-next-line no-console
    console.info(
      `Sedon MCP: ${tools.length} tools available `
      + `(webmcp=${status.webmcp}, window.sedonMcp=${status.windowExpose})`,
    );
  } catch (e) {
    console.error('Failed to register Sedon MCP tools:', e);
  }
  createRoot(root).render(<App />);
})();
