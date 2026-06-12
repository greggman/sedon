import { useMemo } from 'react';
import type { NodeRegistry } from '../core/node-def.js';
import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { docsIndexUrl } from '../docs/doc-paths.js';
import type { Action } from './action.js';
import { getActiveAssetPanel } from './asset-clipboard.js';
import {
  copySelection,
  mergeFromFile,
  pasteFromClipboard,
  saveSelectionToFile,
} from './clipboard-ops.js';
import {
  addNodeAtCanvasCenter,
  cleanupActiveGraph,
  closeActivePanel,
  createPanel,
  createSubgraphAction,
  extractSelectionToSubgraph,
  frameSelectedInActiveCanvas,
  loadDemoById,
  splitActivePanel,
} from './commands.js';
import { DEMOS } from './demos/index.js';
import {
  loadProject,
  newScene,
  saveProject,
  saveProjectToUrl,
} from './file-ops.js';
import { useLayoutStore } from './layout-store.js';
import { navigateCanvasBack, navigateCanvasForward } from './open-graph.js';
import {
  loadRecordingFromFile,
  startRecording,
  stopRecording,
  useRecordingActive,
} from './recording.js';
import { useRegistry } from './registry.js';
import { useEditorStore } from './store.js';

// Single source of truth for "things the user can do." The menu bar
// and the command palette BOTH consume this list — adding an entry
// here makes it appear in the palette automatically, and any menu
// tree that references it by id lights up too. No more parallel
// catalogs: that drift used to mean "New Subgraph…" was wired into
// the Add menu but invisible to the palette.
//
// Conventions:
//   • action.label is the palette form — usually prefixed with the
//     category ("Edit: Undo") so a user can type the category to
//     narrow. Menu trees can override the displayed text per-leaf
//     when the category is implicit in the menu's parent.
//   • action.enabled defaults to true. When the live state says a
//     command isn't applicable right now (e.g. Undo with an empty
//     stack), set false — both surfaces dim the row identically.
//   • All Add: <kind> entries are synthesized from the live registry
//     so a freshly-defined subgraph wrapper / a newly-registered
//     core node show up both in the Add menu and the palette
//     without any menu-tree edit.

function canvasHistoryCanGo(direction: 'back' | 'forward'): boolean {
  const layout = useLayoutStore.getState();
  const panelId = layout.lastActiveCanvasPanelId;
  if (!panelId) return false;
  const h = layout.canvasHistory[panelId];
  if (!h) return false;
  return direction === 'back'
    ? h.cursor > 0
    : h.cursor < h.entries.length - 1;
}

// Macros are a developer-only feature — when the URL gate is off,
// the actions don't get registered at all, so they don't surface in
// either the palette or any menu, even if a menu tree tried to
// reference them. Mirror the macrosAllowed check in app-menus.tsx.
function macrosAllowed(): boolean {
  return (
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('allow-macros') === '1'
  );
}

// Live-state inputs to buildActions. Held off the React-context lock
// so the registry can be exercised from tests without a renderer.
export interface ActionsInput {
  registry: NodeRegistry;
  undoLen: number;
  redoLen: number;
  recording: boolean;
  macrosAllowed: boolean;
}

export function buildActions(input: ActionsInput): Action[] {
  const { registry, undoLen, redoLen, recording, macrosAllowed: macroGate } = input;
  const actions: Action[] = [];

    // ── File ─────────────────────────────────────────────
    // menuLabel set where the menu form differs more than just
    // "drop the category prefix" — the File menu prefers terser
    // wording ("Save…" / "Load…") than the palette form, and the
    // shareable-URL parenthetical reads as noise inside the menu.
    actions.push(
      { id: 'file.new', label: 'File: New Scene', run: () => newScene() },
      { id: 'file.save', label: 'File: Save Project', menuLabel: 'Save…', shortcut: '⌘S', run: () => saveProject() },
      { id: 'file.load', label: 'File: Load Project…', menuLabel: 'Load…', shortcut: '⌘O', run: () => loadProject() },
      {
        id: 'file.save-to-url',
        label: 'File: Save to URL (copy shareable link)',
        menuLabel: 'Save to URL',
        run: () => { void saveProjectToUrl(); },
      },
      {
        id: 'file.save-selected',
        label: 'File: Save Selected…',
        run: () => {
          if (!saveSelectionToFile()) {
            // eslint-disable-next-line no-alert
            alert('Nothing selected. Click nodes in the canvas first.');
          }
        },
      },
      { id: 'file.merge', label: 'File: Merge…', run: () => { void mergeFromFile(); } },
    );

    // ── Demos ────────────────────────────────────────────
    // One action per demo so the Demos submenu in app-menus.tsx can
    // reference them by id. The palette form is documented but the
    // entries are HIDDEN from the palette — too many demo labels
    // (furniture / city / trees / …) collide with real-command
    // searches and steal priority. Users find demos through the
    // File → Demos submenu instead.
    for (const d of DEMOS) {
      actions.push({
        id: `demo.${d.id}`,
        label: `File: Load Demo — ${d.label}`,
        menuLabel: d.label,
        paletteHidden: true,
        run: () => { void loadDemoById(d.id); },
      });
    }

    // ── Edit ─────────────────────────────────────────────
    actions.push(
      {
        id: 'edit.undo',
        label: 'Edit: Undo',
        shortcut: '⌘Z',
        enabled: undoLen > 0,
        run: () => useEditorStore.getState().undo(),
      },
      {
        id: 'edit.redo',
        label: 'Edit: Redo',
        shortcut: '⇧⌘Z',
        enabled: redoLen > 0,
        run: () => useEditorStore.getState().redo(),
      },
      {
        id: 'edit.copy',
        label: 'Edit: Copy',
        shortcut: '⌘C',
        run: () => { void copySelection(); },
      },
      {
        id: 'edit.paste',
        label: 'Edit: Paste',
        shortcut: '⌘V',
        // Default reuse-deps semantics — pasted graph references the
        // target's existing subgraph defs.
        run: () => { void pasteFromClipboard(); },
      },
      {
        id: 'edit.paste-and-copy-deps',
        label: 'Edit: Paste and Copy Deps',
        // rename-all: every transitive subgraph dep is duplicated
        // with a fresh id so the pasted graph is fully independent
        // of the target's existing defs.
        run: () => { void pasteFromClipboard({ mode: 'rename-all' }); },
      },
    );

    // ── Add ──────────────────────────────────────────────
    // "New Subgraph…" lives here as a first-class Add: action.
    // Pre-refactor it was only wired into the Add menu and invisible
    // to the palette — the structural bug the user called out.
    actions.push({
      id: 'add.new-subgraph',
      label: 'Add: New Subgraph…',
      run: () => createSubgraphAction(),
    });
    actions.push({
      id: 'selection.extract-subgraph',
      label: 'Selection: Extract to Subgraph',
      run: () => { extractSelectionToSubgraph(); },
    });
    for (const def of registry.list()) {
      if (isSubgraphInternalKind(def.id)) continue;
      if (isSubgraphInstanceKind(def.id)) continue;
      actions.push({
        id: `add.${def.id}`,
        label: `Add: ${def.id}`,
        run: () => { addNodeAtCanvasCenter(def.id); },
      });
    }

    // ── View ─────────────────────────────────────────────
    actions.push(
      { id: 'view.frame-selected', label: 'View: Frame Selected', shortcut: 'F', run: () => frameSelectedInActiveCanvas() },
      {
        // The action doesn't know about its checked state — that's a
        // menu-display concern (see MenuActionRef.checked + the
        // showLiveNodePreviews handling in app-menus.tsx). Action
        // stays focused on "what does the run do."
        id: 'view.animate-node-previews',
        label: 'View: Animate Node Previews',
        run: () => {
          const cur = useLayoutStore.getState().showLiveNodePreviews;
          useLayoutStore.getState().setShowLiveNodePreviews(!cur);
        },
      },
      { id: 'view.cleanup', label: 'View: Cleanup (Auto-layout)', run: () => cleanupActiveGraph() },
      { id: 'view.split-right', label: 'View: Split Right', run: () => splitActivePanel('right') },
      { id: 'view.split-down', label: 'View: Split Down', run: () => splitActivePanel('below') },
      { id: 'view.new-canvas', label: 'View: New Canvas View', run: () => createPanel('node-canvas', 'Canvas') },
      { id: 'view.new-preview', label: 'View: New Preview View', run: () => createPanel('preview', 'Preview') },
      { id: 'view.new-assets', label: 'View: New Assets View', run: () => createPanel('assets', 'Assets') },
      { id: 'view.close', label: 'View: Close Active Panel', run: () => closeActivePanel() },
      {
        id: 'view.canvas-back',
        label: 'View: Back in Canvas History',
        shortcut: '⌘[',
        enabled: canvasHistoryCanGo('back'),
        run: () => {
          const panelId = useLayoutStore.getState().lastActiveCanvasPanelId;
          if (panelId) navigateCanvasBack(panelId);
        },
      },
      {
        id: 'view.canvas-forward',
        label: 'View: Forward in Canvas History',
        shortcut: '⌘]',
        enabled: canvasHistoryCanGo('forward'),
        run: () => {
          const panelId = useLayoutStore.getState().lastActiveCanvasPanelId;
          if (panelId) navigateCanvasForward(panelId);
        },
      },
    );

    // ── Assets panel actions ─────────────────────────────
    // Route through the most-recently-focused AssetsPanel via the
    // asset-clipboard bus; no-ops if no panel is mounted.
    actions.push(
      { id: 'assets.cut', label: 'Assets: Cut Selected', shortcut: '⌘X', run: () => getActiveAssetPanel()?.performCut() },
      { id: 'assets.copy', label: 'Assets: Copy Selected', shortcut: '⌘C', run: () => getActiveAssetPanel()?.performCopy() },
      { id: 'assets.paste', label: 'Assets: Paste', shortcut: '⌘V', run: () => getActiveAssetPanel()?.performPaste() },
      { id: 'assets.duplicate', label: 'Assets: Duplicate Selected', shortcut: '⌘D', run: () => getActiveAssetPanel()?.performDuplicate() },
      { id: 'assets.delete', label: 'Assets: Delete Selected', shortcut: 'Delete', run: () => getActiveAssetPanel()?.performDelete() },
      { id: 'assets.select-all', label: 'Assets: Select All', shortcut: '⌘A', run: () => getActiveAssetPanel()?.performSelectAll() },
    );

  // ── Macro (developer-only, gated) ────────────────────
  if (macroGate) {
    actions.push(
      {
        id: 'macro.record',
        label: 'Macro: Record',
        enabled: !recording,
        run: () => startRecording(),
      },
      {
        id: 'macro.stop',
        label: 'Macro: Stop Recording',
        enabled: recording,
        run: () => stopRecording(),
      },
      {
        id: 'macro.load',
        label: 'Macro: Load…',
        enabled: !recording,
        run: () => loadRecordingFromFile(),
      },
    );
  }

  // ── Help ─────────────────────────────────────────────
  actions.push({
    id: 'help.docs',
    label: 'Help: Node Documentation',
    run: () => { window.open(docsIndexUrl(), '_blank', 'noreferrer'); },
  });

  return actions;
}

// Hook form: subscribes to the live-state inputs `buildActions` needs
// so the registry rebuilds whenever any of them flip.
export function useActions(): Action[] {
  const registry = useRegistry();
  const undoLen = useEditorStore((s) => s.undoStack.length);
  const redoLen = useEditorStore((s) => s.redoStack.length);
  const recording = useRecordingActive();
  return useMemo(
    () => buildActions({
      registry,
      undoLen,
      redoLen,
      recording,
      macrosAllowed: macrosAllowed(),
    }),
    [registry, undoLen, redoLen, recording],
  );
}

// Convenience: indexed view of useActions(). Menu rendering needs to
// resolve action refs by id, so it's cheaper to index once than to
// linear-scan per leaf.
export function useActionMap(): ReadonlyMap<string, Action> {
  const actions = useActions();
  return useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
}
