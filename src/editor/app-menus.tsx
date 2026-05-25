import { useMemo } from 'react';
import { isSubgraphInternalKind } from '../core/subgraph.js';
import {
  cleanupActiveGraph,
  closeActivePanel,
  createPanel,
  frameSelectedInActiveCanvas,
  loadDemoById,
  promptAndCreateSubgraph,
  splitActivePanel,
} from './commands.js';
import { DEMOS } from './demos/index.js';
import { loadProject, saveProject } from './file-ops.js';
import type { MenuEntry, TopMenu } from './menubar.js';
import { useRegistry } from './registry.js';
import { useEditorStore } from './store.js';

// Build the application menu tree. Lives in a hook because two of the
// menus (Add and Edit) want live store / registry data:
//   • Add → mirrors the right-click "Add Node" categorization, which
//     comes from the runtime registry (subgraph wrappers appear here).
//   • Edit → Undo/Redo are disabled when the corresponding stack is
//     empty, so we read undoStackLen / redoStackLen.
//
// File and View are static once the demos list is fixed.
export function useAppMenus(): TopMenu[] {
  const registry = useRegistry();
  const undoLen = useEditorStore((s) => s.undoStack.length);
  const redoLen = useEditorStore((s) => s.redoStack.length);

  return useMemo<TopMenu[]>(() => {
    // ── File ─────────────────────────────────────────────
    const demoEntries: MenuEntry[] = DEMOS.map((d) => ({
      kind: 'item',
      label: d.label,
      run: () => loadDemoById(d.id),
    }));
    const fileMenu: TopMenu = {
      label: 'File',
      items: [
        { kind: 'item', label: 'Save…', shortcut: '⌘S', run: () => saveProject() },
        { kind: 'item', label: 'Load…', shortcut: '⌘O', run: () => loadProject() },
        { kind: 'separator' },
        { kind: 'submenu', label: 'Demos', items: demoEntries },
      ],
    };

    // ── Edit ─────────────────────────────────────────────
    const editMenu: TopMenu = {
      label: 'Edit',
      items: [
        {
          kind: 'item',
          label: 'Undo',
          shortcut: '⌘Z',
          disabled: undoLen === 0,
          run: () => useEditorStore.getState().undo(),
        },
        {
          kind: 'item',
          label: 'Redo',
          shortcut: '⇧⌘Z',
          disabled: redoLen === 0,
          run: () => useEditorStore.getState().redo(),
        },
      ],
    };

    // ── Add ──────────────────────────────────────────────
    // Group registered NodeDefs by category, exclude subgraph-internal
    // kinds (subgraph-input/*, subgraph-output/*) — they only make
    // sense inside a subgraph, not as a top-level "add this node".
    // Each leaf inserts a node into the active canvas via the same
    // path the right-click Add-Node menu uses.
    const grouped = new Map<string, { id: string; label: string }[]>();
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      const list = grouped.get(def.category) ?? [];
      list.push({ id: def.id, label: def.id });
      grouped.set(def.category, list);
    }
    const categorySubmenus: MenuEntry[] = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, defs]): MenuEntry => ({
        kind: 'submenu',
        label: category,
        items: defs
          .sort((a, b) => a.label.localeCompare(b.label))
          .map((d): MenuEntry => ({
            kind: 'item',
            label: d.label,
            run: () => addNodeAtCanvasCenter(d.id),
          })),
      }));
    const addMenu: TopMenu = {
      label: 'Add',
      items: [
        ...categorySubmenus,
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'New Subgraph…',
          run: () => promptAndCreateSubgraph(),
        },
      ],
    };

    // ── View ─────────────────────────────────────────────
    const viewMenu: TopMenu = {
      label: 'View',
      items: [
        { kind: 'item', label: 'Frame Selected', shortcut: 'F', run: () => frameSelectedInActiveCanvas() },
        { kind: 'item', label: 'Cleanup (Auto-layout)', run: () => cleanupActiveGraph() },
        { kind: 'separator' },
        { kind: 'item', label: 'Split Right', run: () => splitActivePanel('right') },
        { kind: 'item', label: 'Split Down', run: () => splitActivePanel('below') },
        { kind: 'separator' },
        { kind: 'item', label: 'New Canvas View', run: () => createPanel('node-canvas', 'Canvas') },
        { kind: 'item', label: 'New Preview View', run: () => createPanel('preview', 'Preview') },
        { kind: 'item', label: 'New Assets View', run: () => createPanel('assets', 'Assets') },
        { kind: 'separator' },
        { kind: 'item', label: 'Close Active Panel', run: () => closeActivePanel() },
      ],
    };

    return [fileMenu, editMenu, addMenu, viewMenu];
  }, [registry, undoLen, redoLen]);
}

// Insert a node of the given kind into the active canvas, positioned at
// the visible center. Mirrors AddNodeMenu's behavior — it uses the
// active canvas's RF instance to map viewport center to flow coords.
// No-op if no canvas is registered.
function addNodeAtCanvasCenter(kind: string): void {
  // Lazy import to avoid pulling rf-registry into a path with no
  // canvas yet (irrelevant in practice, but the menus are constructed
  // at app-shell render — before any canvas mounts on first load).
  import('./rf-registry.js').then(({ getActiveCanvasRf, getActiveCanvasEl }) => {
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
  });
}
