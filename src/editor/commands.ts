import { useMemo } from 'react';
import { getActiveAssetPanel } from './asset-clipboard.js';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { DEMOS } from './demos/index.js';
import { getDockviewApi } from './dockview-handle.js';
import { loadProject, saveProject } from './file-ops.js';
import { useLayoutStore } from './layout-store.js';
import { layoutGraph, type NodeMeasurement } from './auto-layout.js';
import { getActiveCanvasRf, getCanvasRf } from './rf-registry.js';
import { useEditorStore } from './store.js';

// Catalog of "no-argument" actions invokable from the command palette.
// Each entry is a callable + a human-readable label + an optional
// keyboard shortcut hint (the palette only renders the hint — actual
// global keybindings live in app.tsx).
//
// The list is built per-render via a hook so it can close over the
// active React Flow instance (Save/Load need rf.getNodes / setNodes).
// Everything else reaches into the store or the DockView singleton
// directly, so no React context is captured.

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  /** False means "currently disabled" — the palette still shows it dimmed. */
  enabled?: boolean;
  run: () => void | Promise<void>;
}

export function useCommands(): PaletteCommand[] {
  // Static catalog — no React Flow context needed any more (file-ops
  // operate purely on the store). useMemo just avoids handing a fresh
  // array to the palette every parent render.
  return useMemo(() => buildCommands(), []);
}

function buildCommands(): PaletteCommand[] {
  return [
    {
      id: 'file.save',
      label: 'File: Save Project',
      shortcut: 'Cmd/Ctrl+S',
      run: () => saveProject(),
    },
    {
      id: 'file.load',
      label: 'File: Load Project…',
      shortcut: 'Cmd/Ctrl+O',
      run: () => loadProject(),
    },
    {
      id: 'edit.undo',
      label: 'Edit: Undo',
      shortcut: 'Cmd/Ctrl+Z',
      run: () => useEditorStore.getState().undo(),
    },
    {
      id: 'edit.redo',
      label: 'Edit: Redo',
      shortcut: 'Cmd/Ctrl+Shift+Z',
      run: () => useEditorStore.getState().redo(),
    },
    {
      id: 'view.split-right',
      label: 'View: Split Right',
      run: () => splitActivePanel('right'),
    },
    {
      id: 'view.split-down',
      label: 'View: Split Down',
      run: () => splitActivePanel('below'),
    },
    {
      id: 'view.close',
      label: 'View: Close Active Panel',
      run: () => closeActivePanel(),
    },
    {
      id: 'view.new-canvas',
      label: 'View: Create Canvas View',
      run: () => createPanel('node-canvas', 'Canvas'),
    },
    {
      id: 'view.new-preview',
      label: 'View: Create Preview View',
      run: () => createPanel('preview', 'Preview'),
    },
    {
      id: 'view.new-assets',
      label: 'View: Create Asset View',
      run: () => createPanel('assets', 'Assets'),
    },
    // Assets panel actions. These route through the most-recently-
    // focused AssetsPanel via the asset-clipboard bus, so the user can
    // run "Copy selected" from the palette without first re-focusing
    // the panel. No-ops if no AssetsPanel is mounted.
    {
      id: 'assets.cut',
      label: 'Assets: Cut Selected',
      shortcut: 'Cmd/Ctrl+X',
      run: () => getActiveAssetPanel()?.performCut(),
    },
    {
      id: 'assets.copy',
      label: 'Assets: Copy Selected',
      shortcut: 'Cmd/Ctrl+C',
      run: () => getActiveAssetPanel()?.performCopy(),
    },
    {
      id: 'assets.paste',
      label: 'Assets: Paste',
      shortcut: 'Cmd/Ctrl+V',
      run: () => getActiveAssetPanel()?.performPaste(),
    },
    {
      id: 'assets.duplicate',
      label: 'Assets: Duplicate Selected',
      shortcut: 'Cmd/Ctrl+D',
      run: () => getActiveAssetPanel()?.performDuplicate(),
    },
    {
      id: 'assets.delete',
      label: 'Assets: Delete Selected',
      shortcut: 'Delete',
      run: () => getActiveAssetPanel()?.performDelete(),
    },
    {
      id: 'assets.select-all',
      label: 'Assets: Select All',
      shortcut: 'Cmd/Ctrl+A',
      run: () => getActiveAssetPanel()?.performSelectAll(),
    },
  ];
}

// Generate a panel id distinct from any existing panel. Used by every
// view-creating command so reopening a panel after closing it doesn't
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
  const graph = useEditorStore.getState().graph;
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
  const positions = layoutGraph(graph, measured);
  useEditorStore.getState().commitActivePositions(positions);
}

// Load a demo project by id. Mirrors the old DemosMenu inline handler.
// Guards on confirmDiscardIfDirty so unsaved work isn't silently lost.
export function loadDemoById(id: string): void {
  const demo = DEMOS.find((d) => d.id === id);
  if (!demo) return;
  if (!confirmDiscardIfDirty()) return;
  const { graph, rootNodeId, subgraphs, cameras } = demo.build();
  useEditorStore.getState().setGraph(graph, rootNodeId, subgraphs, cameras);
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
