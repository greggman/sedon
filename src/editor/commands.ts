import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { DEMOS } from './demos/index.js';
import { loadDemoSaveFile } from './demos/demo-loader.js';
import { getDockviewApi } from './dockview-handle.js';
import { useLayoutStore } from './layout-store.js';
import { layoutGraph, type NodeMeasurement } from './auto-layout.js';
import { buildRegistry } from './registry.js';
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

// Frame selected nodes in the active canvas (or fit-all if nothing is
// selected). Mirrors the in-canvas F-key handler so the View menu and
// shortcut share one definition.
export function frameSelectedInActiveCanvas(): void {
  const rf = getActiveCanvasRf();
  if (!rf) return;
  const allNodes = rf.getNodes();
  if (allNodes.length === 0) return;
  const selected = allNodes.filter((n) => n.selected);
  const target = selected.length > 0 ? selected : allNodes;
  rf.fitView({ padding: 0.2, nodes: target.map((n) => ({ id: n.id })), duration: 200 });
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

// Slugify + create-and-edit, lifted from the old NewSubgraphButton.
// Uses window.prompt for the label — same low-fi UX as before.
export function promptAndCreateSubgraph(): void {
  const label = window.prompt('New subgraph name:', 'Custom');
  if (label === null) return;
  const trimmed = label.trim();
  if (trimmed.length === 0) return;
  const existing = new Set(useEditorStore.getState().subgraphs.map((s) => s.id));
  const id = slugifyForSubgraph(trimmed, existing);
  useEditorStore.getState().createSubgraph(id, trimmed);
}

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

// Insert a node of the given kind into the active canvas, positioned at
// the visible center. Mirrors the right-click AddNodeMenu's placement —
// the active canvas's RF instance maps the canvas-center screen point
// to flow coordinates. No-op if no canvas is registered.
export function addNodeAtCanvasCenter(kind: string): void {
  const rf = getActiveCanvasRf();
  if (!rf) return;
  const id = crypto.randomUUID();
  let position = { x: 100, y: 100 };
  const el = getActiveCanvasEl();
  if (el) {
    const r = el.getBoundingClientRect();
    position = rf.screenToFlowPosition({
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
    });
  }
  rf.addNodes({ id, type: 'sedon', position, data: { kind } });
  useEditorStore.getState().addNode({ id, kind });
}

// Filter helper used by both the Add menu's category grouping and
// (indirectly, via actions.ts) the palette's Add: <kind> generator.
// Exported for tests.
export function isUserAddableKind(kindId: string): boolean {
  if (isSubgraphInternalKind(kindId)) return false;
  if (isSubgraphInstanceKind(kindId)) return false;
  return true;
}
