import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { DEMOS } from './demos/index.js';
import { loadDemoSaveFile } from './demos/demo-loader.js';
import { getDockviewApi } from './dockview-handle.js';
import { useLayoutStore } from './layout-store.js';
import { layoutGraph, type NodeMeasurement } from './auto-layout.js';
import { activePanelIsPreview, getActivePreview } from './preview-registry.js';
import { buildRegistry } from './registry.js';
import { requestNodeRename, requestSubgraphRename } from './rename-bus.js';
import { getActiveCanvasEl, getActiveCanvasRf, getCanvasRf } from './rf-registry.js';
import { useEditorStore } from './store.js';

// Utility helpers shared by the action registry, the menu builder,
// and the canvas / panel toolbars. Pure operations on the store +
// DockView API — no UI shape. The old PaletteCommand catalog that
// also lived here was deleted: actions are now defined in
// ./actions.ts as the single source of truth that both the menu bar
// and the command palette consume.
//
// Convention: every function here is a noun-of-action with a clear
// side effect (createPanel, cleanupActiveGraph, etc.) that an
// `Action.run` can call directly. Anyone tempted to add a one-off
// "PaletteCommand"-shaped value here should add an Action in
// ./actions.ts instead.

// Re-exported so the asset-paste-clone (and other) implementations
// reach the same helper isSubgraphInternalKind/isSubgraphInstanceKind
// import some consumers used to thread through this file. They were
// always re-exports of core/subgraph; callers should import directly.

// Generate a panel id distinct from any existing panel. Used by every
// view-creating helper so reopening a panel after closing it doesn't
// collide with a stale id elsewhere in the DockView model.
function freshPanelId(component: string): string {
  return `${component}-${crypto.randomUUID().slice(0, 8)}`;
}

export function splitActivePanel(direction: 'right' | 'below'): void {
  const api = getDockviewApi();
  if (!api) return;
  const active = api.activePanel;
  if (!active) {
    // No active panel (e.g. all closed) — fall back to placing a new
    // canvas at the top level so the user isn't stuck with nowhere to
    // split from.
    createPanel('node-canvas', 'Canvas');
    return;
  }
  // Duplicate the active panel's type rather than always creating a
  // canvas. "Split Right" on a Preview yields a second Preview, which
  // is what users expect from editor splits.
  const component = active.view.contentComponent;
  const newPanelId = freshPanelId(component);
  const layout = useLayoutStore.getState();

  // Sibling-prefer for splits: the new panel should land on the same
  // graph showing the same view as the panel it was split from, so
  // the split looks like a literal duplication. We seed the new
  // panel's per-panel slot BEFORE addPanel; the auto-pin effect in
  // NodeCanvas/Preview sees the slot already populated and skips
  // its own default seeding. The viewport/camera effect then restores
  // from the seeded slot instead of falling through to fitView or LRU.
  if (component === 'node-canvas') {
    const sourceGraphId = layout.canvasGraphIds[active.id];
    const sourceRf = getCanvasRf(active.id);
    if (sourceGraphId) {
      layout.setCanvasGraphId(newPanelId, sourceGraphId);
      if (sourceRf) {
        layout.saveCanvasViewport(newPanelId, sourceGraphId, sourceRf.getViewport());
      }
      // Splits should look like a literal duplication, including the
      // navigation history — so the new pane's Back/Forward buttons
      // start where the source's were.
      layout.cloneCanvasHistory(active.id, newPanelId);
    }
  } else if (component === 'preview') {
    const sourcePinned = layout.pinnedGraphIds[active.id];
    if (sourcePinned) {
      layout.setPanelPinnedGraph(newPanelId, sourcePinned);
      const sourceCamera = layout.previewCameras[active.id]?.[sourcePinned];
      if (sourceCamera) {
        layout.savePreviewCamera(newPanelId, sourcePinned, sourceCamera);
      }
    }
  }

  api.addPanel({
    id: newPanelId,
    component,
    title: defaultTitle(component),
    position: { referencePanel: active.id, direction },
  });
}

export function closeActivePanel(): void {
  const api = getDockviewApi();
  if (!api) return;
  const active = api.activePanel;
  if (!active) return;
  api.removePanel(active);
}

export function createPanel(component: string, title: string): void {
  const api = getDockviewApi();
  if (!api) return;
  api.addPanel({
    id: freshPanelId(component),
    component,
    title,
  });
}

function defaultTitle(component: string): string {
  switch (component) {
    case 'node-canvas':
      return 'Canvas';
    case 'preview':
      return 'Preview';
    case 'assets':
      return 'Assets';
    default:
      return component;
  }
}

// `View → Frame Selected` action. Routes based on which panel type
// is currently active so the same menu item / shortcut works in
// both contexts:
//   • Canvas active → fit React Flow viewport to selected nodes (or
//     all nodes if nothing is selected).
//   • Preview active → orbit camera frames the selected entity (or
//     the whole scene if nothing is selected).
//
// Function name is kept (callers depend on it) but it now also
// covers the preview path. When BOTH a preview and canvas panel
// exist, dockview's `activePanel` wins; otherwise we prefer the
// canvas (default focus in most layouts).
export function frameSelectedInActiveCanvas(): void {
  if (activePanelIsPreview()) {
    const preview = getActivePreview();
    if (preview) {
      preview.frameSelected();
      return;
    }
  }
  const rf = getActiveCanvasRf();
  if (!rf) {
    // Canvas isn't focused — try the preview as a fallback before
    // bailing. Covers the case where the user clicked the menu bar
    // (dockview's active panel is now the menu) but they were last
    // looking at a preview.
    const preview = getActivePreview();
    if (preview) preview.frameSelected();
    return;
  }
  const allNodes = rf.getNodes();
  if (allNodes.length === 0) return;
  const selected = allNodes.filter((n) => n.selected);
  if (selected.length > 0) {
    rf.fitView({ padding: 0.2, nodes: selected.map((n) => ({ id: n.id })), duration: 200 });
  } else {
    // No `nodes` → ReactFlow's all-nodes path. Same fix the in-canvas
    // F-key handler uses; see node-canvas.tsx onFrameKey.
    rf.fitView({ padding: 0.2, duration: 200 });
  }
}

// Auto-arrange the current graph's nodes via rank-based layered layout.
// Same code path as the old CleanupButton — measured node dimensions
// come from the active canvas's RF instance, the layout result writes
// through commitActivePositions so every canvas viewing this graph
// re-syncs.
export function cleanupActiveGraph(): void {
  const rf = getActiveCanvasRf();
  if (!rf) return;
  const state = useEditorStore.getState();
  const graph = state.graph;
  const rfNodes = rf.getNodes();
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of rfNodes) {
    const m = n.measured;
    if (!m) { measured.set(n.id, undefined); continue; }
    const entry: NodeMeasurement = {};
    if (m.width !== undefined) entry.width = m.width;
    if (m.height !== undefined) entry.height = m.height;
    measured.set(n.id, entry);
  }
  // Hand layoutGraph the registry so its crossing-minimisation phase
  // can score edges by the SOCKET they terminate on, not just by the
  // target node's rank position. Without this, two sources whose
  // edges both land on the same target tie on score and fall back to
  // insertion order — producing the "aaa connects to socket b, bbb
  // connects to socket a, but aaa stays on top" wire-crossing.
  const registry = buildRegistry(state.subgraphs);
  const positions = layoutGraph(graph, measured, registry);
  state.commitActivePositions(positions);
}

// Load a demo project by id. Guards on confirmDiscardIfDirty so
// unsaved work isn't silently lost. Async because demos live as
// `dist/demos/<id>.sedon` files produced at build time; we fetch +
// parse on demand instead of shipping every demo graph in the
// runtime JS bundle.
export async function loadDemoById(id: string): Promise<void> {
  const demo = DEMOS.find((d) => d.id === id);
  if (!demo) return;
  if (!confirmDiscardIfDirty()) return;
  const saveFile = await loadDemoSaveFile(id);
  const { graph, rootNodeId, subgraphs, cameras } = saveFile.project;
  useEditorStore.getState().setGraph(graph, rootNodeId, subgraphs ?? [], cameras);
}

// Default name for a fresh subgraph. Finder-style: the rename UI
// pops up immediately on creation, so the placeholder only needs to
// be reasonable for the half-second before the user starts typing.
const NEW_SUBGRAPH_LABEL = 'untitled subgraph';

// Create a new subgraph; behavior is context-sensitive based on
// which DockView panel is focused:
//
//   • Canvas focused  → create the subgraph, hop back to the parent
//                       graph the user was just editing, drop a
//                       wrapper node referencing the new subgraph
//                       into that canvas, frame the canvas on it,
//                       and immediately enter rename mode on the
//                       wrapper's header.
//   • Asset focused / no focus → create the subgraph standalone.
//                       The store hops into the new subgraph so the
//                       user can start wiring its insides. The asset
//                       panel auto-navigates to where the new tile
//                       lives, scrolls it into view, and starts
//                       inline rename.
//
// No prompt — the name defaults to "untitled subgraph" and the rename
// UI handles the actual naming, the way Finder does for new folders.
export function createSubgraphAction(): void {
  const store = useEditorStore.getState();
  const existing = new Set(store.subgraphs.map((s) => s.id));
  const id = slugifyForSubgraph(NEW_SUBGRAPH_LABEL, existing);

  const api = getDockviewApi();
  const onCanvas = api?.activePanel?.view.contentComponent === 'node-canvas';

  if (!onCanvas) {
    store.createSubgraph(id, NEW_SUBGRAPH_LABEL);
    // Ask the asset panel to enter rename mode on the new tile.
    // Persists across renders until consumed, so an asset panel that
    // hasn't mounted yet still picks it up the moment it does.
    requestSubgraphRename(id);
    return;
  }

  // Canvas context: wrapper at canvas center; frame on it; rename.
  createSubgraphAt(undefined);
}

// Create-subgraph-and-place-wrapper-at-a-specific-flow-position
// variant. `flowPos === undefined` falls back to the canvas center
// (the menu's Add Subgraph item uses an explicit position from the
// right-click; the menubar / palette use the center).
export function createSubgraphAt(flowPos: { x: number; y: number } | undefined): void {
  const store = useEditorStore.getState();
  const existing = new Set(store.subgraphs.map((s) => s.id));
  const id = slugifyForSubgraph(NEW_SUBGRAPH_LABEL, existing);

  const parentGraphId = store.currentEditingId;
  store.createSubgraph(id, NEW_SUBGRAPH_LABEL);
  store.setActiveEditing(parentGraphId);

  const newNodeId =
    flowPos !== undefined
      ? addNodeAtFlowPosition(`subgraph/${id}`, flowPos.x, flowPos.y)
      : addNodeAtCanvasCenter(`subgraph/${id}`);

  if (!newNodeId) return;

  // Frame the canvas on the new wrapper so the user can see what
  // they're about to rename. A short animation reads better than
  // a jump cut even though the wrapper is the only thing changing
  // on screen.
  const rf = getActiveCanvasRf();
  if (rf) {
    // Defer so RF's internal layout pass picks up the just-added
    // node's measured dimensions before fitView centers on it.
    requestAnimationFrame(() => {
      rf.fitView({
        padding: 0.6,
        nodes: [{ id: newNodeId }],
        duration: 250,
        maxZoom: 1.5,
      });
    });
  }
  requestNodeRename(newNodeId);
}

// Old name kept as an alias for any imports we missed (and a hint
// to future readers about what changed). New code should call
// createSubgraphAction directly.
export const promptAndCreateSubgraph = createSubgraphAction;

function slugifyForSubgraph(label: string, existing: ReadonlySet<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'subgraph';
  if (!existing.has(base) && base !== 'main') return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate) && candidate !== 'main') return candidate;
  }
}

// Insert a node of the given kind at an explicit flow-coordinate
// position on the active canvas. Returns the new node's id (or null
// if no canvas is registered).
export function addNodeAtFlowPosition(
  kind: string,
  flowX: number,
  flowY: number,
): string | null {
  const rf = getActiveCanvasRf();
  if (!rf) return null;
  const id = crypto.randomUUID();
  const position = { x: flowX, y: flowY };
  rf.addNodes({ id, type: 'sedon', position, data: { kind } });
  // Pass position through to the store too; the RF instance has it
  // locally, but the store's GraphNode is what gets serialised at
  // save time, and without this the position wouldn't survive a
  // reload until the user dragged the node at least once.
  useEditorStore.getState().addNode({ id, kind, position });
  return id;
}

// Insert a node positioned at the active canvas's visible center.
// Used by the toolbar "+ Add Node" button and any action that lacks
// an explicit position.
export function addNodeAtCanvasCenter(kind: string): string | null {
  const rf = getActiveCanvasRf();
  if (!rf) return null;
  let flowX = 100;
  let flowY = 100;
  const el = getActiveCanvasEl();
  if (el) {
    const r = el.getBoundingClientRect();
    const pos = rf.screenToFlowPosition({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    });
    flowX = pos.x;
    flowY = pos.y;
  }
  return addNodeAtFlowPosition(kind, flowX, flowY);
}

// Filter helper used by both the Add menu's category grouping and
// (indirectly, via actions.ts) the palette's Add: <kind> generator.
// Exported for tests.
export function isUserAddableKind(kindId: string): boolean {
  if (isSubgraphInternalKind(kindId)) return false;
  if (isSubgraphInstanceKind(kindId)) return false;
  return true;
}

// "Extract to Subgraph" / "Create subscene from selection." Takes
// the current canvas selection (or an explicit override id set),
// builds a new subgraph that encapsulates those nodes, and replaces
// them in the parent graph with a wrapper. Single undoable step.
//
// On success: frames the active canvas on the new wrapper and asks
// the rename bus to start the inline rename — Finder-style. On
// empty / all-boundary selection, alerts the user instead of
// silently no-opping (the menu doesn't gate visibility on selection
// state, so a friendly nudge is better than a dead click).
export function extractSelectionToSubgraph(
  ids?: ReadonlySet<string>,
): { subgraphId: string; wrapperId: string } | null {
  const rf = getActiveCanvasRf();
  let targetIds = ids;
  if (!targetIds) {
    if (!rf) return null;
    const selected = new Set<string>();
    for (const n of rf.getNodes()) {
      if (n.selected) selected.add(n.id);
    }
    targetIds = selected;
  }
  if (targetIds.size === 0) {
    // eslint-disable-next-line no-alert
    alert('Select one or more nodes first, then run "Extract to Subgraph".');
    return null;
  }
  const state = useEditorStore.getState();
  const registry = buildRegistry(state.subgraphs);
  const result = state.extractSelectionAsSubgraph(targetIds, registry);
  if (!result) return null;
  if (rf) {
    requestAnimationFrame(() => {
      rf.fitView({
        padding: 0.6,
        nodes: [{ id: result.wrapperId }],
        duration: 250,
        maxZoom: 1.5,
      });
    });
  }
  // Start inline rename on the new wrapper so the user can name the
  // freshly-extracted subgraph immediately, just like New Subgraph.
  void import('./rename-bus.js').then((m) => {
    m.requestNodeRename(result.wrapperId);
  });
  return result;
}
