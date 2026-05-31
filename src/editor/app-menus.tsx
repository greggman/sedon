import { useMemo } from 'react';
import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { docsIndexUrl } from '../docs/doc-paths.js';
import {
  addNodeAtCanvasCenter,
  cleanupActiveGraph,
  closeActivePanel,
  createPanel,
  frameSelectedInActiveCanvas,
  loadDemoById,
  promptAndCreateSubgraph,
  splitActivePanel,
} from './commands.js';
import { DEMOS } from './demos/index.js';
import {
  copySelection,
  mergeFromFile,
  pasteFromClipboard,
  saveSelectionToFile,
} from './clipboard-ops.js';
import { loadProject, saveProject, saveProjectToUrl } from './file-ops.js';
import { startRecording, stopRecording, loadRecordingFromFile, recordingActive } from './recording.js';
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
        { kind: 'item', label: 'Save to URL', run: () => { void saveProjectToUrl(); } },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Save Selected…',
          run: () => {
            if (!saveSelectionToFile()) {
              // eslint-disable-next-line no-alert
              alert('Nothing selected. Click nodes in the canvas first.');
            }
          },
        },
        {
          kind: 'item',
          label: 'Merge…',
          run: () => { void mergeFromFile(); },
        },
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
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Copy',
          shortcut: '⌘C',
          run: () => { void copySelection(); },
        },
        {
          kind: 'item',
          label: 'Paste',
          shortcut: '⌘V',
          // Default reuse-deps semantics: another reference to the
          // thing you copied, sharing dependencies with the target.
          run: () => { void pasteFromClipboard(); },
        },
        {
          kind: 'item',
          label: 'Paste and Copy Deps',
          // rename-all mode — every transitive subgraph dep is
          // duplicated with a fresh id, so the pasted graph is fully
          // independent of the target's existing defs. Useful when
          // you intend to edit the deps without affecting the
          // original.
          run: () => { void pasteFromClipboard({ mode: 'rename-all' }); },
        },
      ],
    };

    // ── Add ──────────────────────────────────────────────
    // Group registered NodeDefs by category. Two kinds are excluded:
    //   • subgraph-internal (subgraph-input/*, subgraph-output/*) —
    //     only meaningful inside a subgraph, not a top-level "add".
    //   • subgraph wrapper instances (subgraph/<id>) — the Asset panel
    //     is the canonical place for those, with folders, drag-to-
    //     canvas, and thumbnails. Listing them here too creates a
    //     second discovery surface that fills up with every wrapper.
    // Each leaf inserts a node into the active canvas via the same
    // path the right-click Add-Node menu uses.
    const grouped = new Map<string, { id: string; label: string }[]>();
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      if (isSubgraphInstanceKind(def.id)) continue;
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

    // ── Macro ────────────────────────────────────────────
    // NOT a user-facing feature — exists so bug reports can ship a
    // `.sedon-rec` file (a strict replay of every store-action call
    // since Record was clicked) instead of writing out manual repro
    // steps. The recording captures the starting project snapshot up
    // front, so replay reconstructs exactly the state the recording
    // was made against. See src/editor/recording.ts.
    //
    // Gated behind `?allow-macros=1` so the menu doesn't appear in
    // normal sessions — recording is purely a developer / bug-repro
    // tool right now. The wrapping mechanism in recording.ts (and
    // `?log-commands=1`) stays available regardless of the menu gate.
    const recording = recordingActive();
    const macroMenu: TopMenu = {
      label: 'Macro',
      items: [
        {
          kind: 'item',
          label: 'Record',
          disabled: recording,
          run: () => startRecording(),
        },
        {
          kind: 'item',
          label: 'Stop Recording',
          disabled: !recording,
          run: () => stopRecording(),
        },
        { kind: 'separator' },
        {
          kind: 'item',
          label: 'Load…',
          disabled: recording,
          run: () => loadRecordingFromFile(),
        },
      ],
    };
    const macrosAllowed =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('allow-macros') === '1';

    // ── Help ─────────────────────────────────────────────
    const helpMenu: TopMenu = {
      label: 'Help',
      items: [
        {
          kind: 'item',
          label: 'Node Documentation',
          run: () => { window.open(docsIndexUrl(), '_blank', 'noreferrer'); },
        },
      ],
    };

    return [
      fileMenu,
      editMenu,
      addMenu,
      viewMenu,
      ...(macrosAllowed ? [macroMenu] : []),
      helpMenu,
    ];
  }, [registry, undoLen, redoLen]);
}

