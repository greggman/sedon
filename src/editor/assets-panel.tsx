import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  buildFolderIndex,
  ROOT_FOLDER_ID,
  type Folder,
} from '../core/folder.js';
import type { SubgraphDef } from '../core/subgraph.js';
import {
  getActiveAssetPanel,
  setActiveAssetPanel,
  useAssetClipboardStore,
  type AssetPanelHandle,
} from './asset-clipboard.js';
import type { AssetSelection } from './asset-ops.js';
import { AssetThumbnail } from './asset-thumbnail.js';
import { useLayoutStore } from './layout-store.js';
import { openGraphInCanvas, openGraphInPreview } from './open-graph.js';
import { useEditorStore } from './store.js';

// Pixel size of the live subgraph preview shown in icon-view tiles.
// Matches roughly the natural tile width set by the icon-grid CSS so
// the canvas isn't upscaled past its rendered size.
const THUMBNAIL_PX = 64;

// Drag-and-drop MIME type for asset moves. The payload is JSON-encoded
// `AssetDndItem[]` — a list, since a single drag gesture can carry an
// entire multi-selection. Consumers that only handle one item at a time
// (e.g. the Preview pin) just read the first.
//
// Asset payloads carry their kind:
//   • subgraph — instantiate / move / pin
//   • folder   — move (Asset view only)
//   • main     — pin (the root graph; never instantiable as a wrapper)
export const ASSET_DND_TYPE = 'application/sedon-asset';

export interface AssetDndItem {
  kind: 'folder' | 'subgraph' | 'main';
  id: string;
}

// The id used by the preview pin / GraphSwitcher for the project's root
// graph. Mirrors the literal used in store.ts and preview.tsx — kept
// here so the asset view doesn't have to import either one just to make
// a drag payload.
const MAIN_GRAPH_ID = 'main';

type AssetTarget = AssetDndItem | { kind: 'root' };
type ViewMode = 'icons' | 'list';
type RenameTarget = { kind: 'folder' | 'subgraph'; id: string } | null;
type ContextMenu = {
  x: number;
  y: number;
  target: AssetTarget;
} | null;

// Encoded selection key. Subgraphs and folders share a single Set so a
// mixed multi-select is straightforward to test for membership.
type SelectionKey = `subgraph:${string}` | `folder:${string}`;
function keyOfSubgraph(id: string): SelectionKey {
  return `subgraph:${id}`;
}
function keyOfFolder(id: string): SelectionKey {
  return `folder:${id}`;
}
function decodeKey(key: SelectionKey): { kind: 'subgraph' | 'folder'; id: string } {
  return key.startsWith('subgraph:')
    ? { kind: 'subgraph', id: key.slice('subgraph:'.length) }
    : { kind: 'folder', id: key.slice('folder:'.length) };
}
function selectionToAssetSelection(selection: ReadonlySet<SelectionKey>): AssetSelection {
  const subgraphIds: string[] = [];
  const folderIds: string[] = [];
  for (const key of selection) {
    const d = decodeKey(key);
    if (d.kind === 'subgraph') subgraphIds.push(d.id);
    else folderIds.push(d.id);
  }
  return { subgraphIds, folderIds };
}

// =========================================================================
// AssetsPanel — Unity-style two-pane Project view with rename, context
// menu, multi-selection, drag-and-drop, clipboard, and Icons / List view
// modes.
//
//   ┌──────────────┬──────────────────────────────────────────┐
//   │ Folder tree  │ Selected folder's contents               │
//   │              │ ╔═════════╗ ╔═════════╗ ╔═════════╗      │
//   │ ▾ Project    │ ║ 📁      ║ ║ ◇        ║ ║ ◇        ║   │
//   │   ▾ Trees    │ ║ Trees   ║ ║ Bark Tex ║ ║ Oak Leaf ║   │
//   │   ▸ Bushes   │ ╚═════════╝ ╚═════════╝ ╚═════════╝      │
//   │              │                                          │
//   └──────────────┴──────────────────────────────────────────┘
//
// Selection: click replaces, cmd/ctrl-click toggles, shift-click extends
// the range from the anchor. Marquee-select in icon view drags a rect.
// Cmd+A selects everything in the active folder; Esc clears.
//
// Operations on the selection: Cmd+D duplicate, Delete/Backspace delete
// (with broken-ref confirmation), Cmd+X cut / Cmd+C copy / Cmd+V paste.
// All ops are also available via right-click and the command palette.
// =========================================================================
export function AssetsPanel() {
  const folders = useEditorStore(useShallow((s) => s.folders));
  // Filter out node-owned bridges (for-each-point's private iteration
  // wiring graphs). They live in `state.subgraphs` alongside
  // user-authored subgraphs because they share the same eval +
  // serialize machinery, but they're not user assets — only the
  // owning for-each-point's "Edit iteration" affordance navigates
  // into them.
  const subgraphs = useEditorStore(useShallow((s) =>
    s.subgraphs.filter((sg) => sg.owner?.kind !== 'iteration-bridge'),
  ));
  const createFolder = useEditorStore((s) => s.createFolder);
  const renameFolder = useEditorStore((s) => s.renameFolder);
  const renameSubgraph = useEditorStore((s) => s.renameSubgraph);
  const deleteAssets = useEditorStore((s) => s.deleteAssets);
  const duplicateAssets = useEditorStore((s) => s.duplicateAssets);
  const moveAssets = useEditorStore((s) => s.moveAssets);
  const pasteCopyAssets = useEditorStore((s) => s.pasteCopyAssets);
  const countBrokenRefs = useEditorStore((s) => s.countBrokenRefs);

  const clipboard = useAssetClipboardStore((s) => s.clipboard);
  const setCut = useAssetClipboardStore((s) => s.setCut);
  const setCopy = useAssetClipboardStore((s) => s.setCopy);
  const clearClipboard = useAssetClipboardStore((s) => s.clear);

  // Folder-tree / contents divider drag. The tree's width is stored
  // globally (project-wide) in layout-store; the divider's pointer
  // handler captures the pointer and writes the new width on every
  // move. `bodyRef` lets us convert clientX into a pane-local width
  // without measuring during the gesture (one read on pointerdown,
  // delta-from-event-x to width on each move).
  const treeWidth = useLayoutStore((s) => s.assetsTreeWidth);
  const setTreeWidth = useLayoutStore((s) => s.setAssetsTreeWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const body = bodyRef.current;
    if (!body) return;
    e.preventDefault();
    const bodyLeft = body.getBoundingClientRect().left;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const onMove = (mv: PointerEvent) => {
      setTreeWidth(mv.clientX - bodyLeft);
    };
    const onUp = (up: PointerEvent) => {
      try { handle.releasePointerCapture(up.pointerId); } catch { /* already released */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, [setTreeWidth]);

  // ----- UI state -----
  // Tree expansion. Auto-expands ancestors of the selected folder so the
  // tree always shows the active selection without manual disclosure.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_FOLDER_ID]));
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Selected folder for the right pane. `ROOT_FOLDER_ID` is the synthetic
  // "Project root" node — selecting it shows top-level items.
  const [selectedFolderId, setSelectedFolderId] = useState<string>(ROOT_FOLDER_ID);
  const [renaming, setRenaming] = useState<RenameTarget>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('icons');

  // Tile multi-selection (right pane). Independent of `selectedFolderId`
  // (which only tracks which folder's contents are visible).
  const [tileSelection, setTileSelection] = useState<Set<SelectionKey>>(() => new Set());
  // Anchor for shift-click range extension. Reset on plain click and
  // cmd/ctrl-click; preserved through shift-click so dragging the range
  // back and forth works as expected.
  const anchorRef = useRef<SelectionKey | null>(null);

  // Delete confirmation dialog. `null` = no dialog; otherwise contains
  // the pending selection + the broken-ref count so the user knows the
  // blast radius before confirming.
  const [confirmDelete, setConfirmDelete] = useState<{
    selection: AssetSelection;
    refs: number;
    graphs: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentsRef = useRef<HTMLDivElement>(null);

  // Expand the chain of ancestors leading to the selected folder, so
  // selecting a deep folder from elsewhere (e.g. a future "find" action)
  // naturally surfaces it in the tree.
  useEffect(() => {
    if (selectedFolderId === ROOT_FOLDER_ID) return;
    const byId = new Map(folders.map((f) => [f.id, f]));
    const toExpand: string[] = [ROOT_FOLDER_ID];
    let cursor: string | null = selectedFolderId;
    while (cursor !== null) {
      const f = byId.get(cursor);
      if (!f) break;
      toExpand.push(f.parentFolderId ?? ROOT_FOLDER_ID);
      cursor = f.parentFolderId;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of toExpand) next.add(id);
      return next;
    });
  }, [selectedFolderId, folders]);

  // Close the context menu on any outside click / Escape.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  // F2 → rename the current folder-tree selection. Ignored while typing
  // in an input/textarea so it doesn't fight with text editing
  // elsewhere. Tile-selection rename is via right-click → Rename.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return;
      // Prefer a single tile-selected item; fall back to the tree folder.
      if (tileSelection.size === 1) {
        const only = [...tileSelection][0]!;
        setRenaming(decodeKey(only));
        return;
      }
      if (selectedFolderId === ROOT_FOLDER_ID) return;
      setRenaming({ kind: 'folder', id: selectedFolderId });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFolderId, tileSelection]);

  const index = useMemo(
    () => buildFolderIndex(folders, subgraphs),
    [folders, subgraphs],
  );

  // Live-prune the tile selection whenever the folders/subgraphs arrays
  // change so deletions made elsewhere (or undo/redo) don't leave stale
  // keys in the selection set.
  useEffect(() => {
    const validFolderIds = new Set(folders.map((f) => f.id));
    const validSubgraphIds = new Set(subgraphs.map((s) => s.id));
    setTileSelection((prev) => {
      let changed = false;
      const next = new Set<SelectionKey>();
      for (const key of prev) {
        const d = decodeKey(key);
        if (d.kind === 'folder' ? validFolderIds.has(d.id) : validSubgraphIds.has(d.id)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [folders, subgraphs]);

  // ----- Visible-tile order in the current folder -----
  // Anchor expansion (shift-click) and Cmd+A both need a stable ordering
  // of tiles in the active folder. Computed once per render from the
  // folder index; matches what AssetsContents actually renders.
  const visibleKeys = useMemo<SelectionKey[]>(() => {
    const entry = index.get(selectedFolderId);
    if (!entry) return [];
    const keys: SelectionKey[] = [];
    // Main always shows at the project root.
    // It isn't selectable for delete/duplicate/cut, so we omit it from
    // the visible-key list. (Cmd+A in root selects subgraphs + folders
    // only, leaving Main alone.)
    for (const f of entry.childFolders) keys.push(keyOfFolder(f.id));
    for (const sg of entry.subgraphs) keys.push(keyOfSubgraph(sg.id));
    return keys;
  }, [index, selectedFolderId]);

  // ----- Selection helpers -----
  const clearSelection = useCallback(() => {
    setTileSelection((prev) => (prev.size === 0 ? prev : new Set()));
    anchorRef.current = null;
  }, []);

  const replaceSelection = useCallback((keys: ReadonlyArray<SelectionKey>) => {
    setTileSelection(new Set(keys));
    anchorRef.current = keys.length > 0 ? keys[keys.length - 1]! : null;
  }, []);

  const toggleInSelection = useCallback((key: SelectionKey) => {
    setTileSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    anchorRef.current = key;
  }, []);

  // Shift-click range: from anchor to clicked, in visibleKeys order.
  // If no anchor, falls back to a plain replace.
  const extendRangeTo = useCallback(
    (key: SelectionKey) => {
      const anchor = anchorRef.current;
      if (!anchor || !visibleKeys.includes(anchor)) {
        replaceSelection([key]);
        return;
      }
      const a = visibleKeys.indexOf(anchor);
      const b = visibleKeys.indexOf(key);
      if (a < 0 || b < 0) {
        replaceSelection([key]);
        return;
      }
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setTileSelection(new Set(visibleKeys.slice(lo, hi + 1)));
      // Anchor unchanged so the next shift-click extends from the same
      // origin — standard file-manager behavior.
    },
    [visibleKeys, replaceSelection],
  );

  // Click on a tile. Modifier logic mirrors Finder/Explorer.
  const onTileClick = useCallback(
    (key: SelectionKey, e: React.MouseEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (e.shiftKey) {
        extendRangeTo(key);
      } else if (meta) {
        toggleInSelection(key);
      } else {
        replaceSelection([key]);
      }
    },
    [extendRangeTo, toggleInSelection, replaceSelection],
  );

  // ----- Actions -----
  const onNewFolder = (parentId: string | null) => {
    const label = `New Folder ${folders.length + 1}`;
    const newId = createFolder(parentId, label);
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(parentId ?? ROOT_FOLDER_ID);
      next.add(newId);
      return next;
    });
    setSelectedFolderId(newId);
    // Open the rename editor immediately so the user can name it on
    // creation, like Finder / Explorer.
    setRenaming({ kind: 'folder', id: newId });
  };
  const onNewFolderFromToolbar = () => {
    const parent = selectedFolderId === ROOT_FOLDER_ID ? null : selectedFolderId;
    onNewFolder(parent);
  };

  // ----- Multi-asset operations (selection-driven) -----
  const performDelete = useCallback(() => {
    if (tileSelection.size === 0) return;
    const selection = selectionToAssetSelection(tileSelection);
    // Confirmation when removing subgraphs that have wrapper
    // references elsewhere — let the user see what will break before
    // they commit. Folders alone never break refs (their contained
    // subgraphs survive via re-parenting), so we count only the
    // subgraph side.
    const refInfo = countBrokenRefs(new Set(selection.subgraphIds));
    if (refInfo.refs > 0) {
      setConfirmDelete({ selection, refs: refInfo.refs, graphs: refInfo.graphs });
      return;
    }
    deleteAssets(selection);
    clearSelection();
    if (clipboard?.mode === 'cut') clearClipboard();
  }, [tileSelection, countBrokenRefs, deleteAssets, clearSelection, clipboard, clearClipboard]);

  const performDuplicate = useCallback(() => {
    if (tileSelection.size === 0) return;
    const selection = selectionToAssetSelection(tileSelection);
    const newSel = duplicateAssets(selection);
    // Move selection to the freshly-created clones so the user can
    // immediately rename / drag / further-duplicate them.
    const nextKeys: SelectionKey[] = [
      ...newSel.subgraphIds.map(keyOfSubgraph),
      ...newSel.folderIds.map(keyOfFolder),
    ];
    if (nextKeys.length > 0) replaceSelection(nextKeys);
  }, [tileSelection, duplicateAssets, replaceSelection]);

  const performCut = useCallback(() => {
    if (tileSelection.size === 0) return;
    setCut(selectionToAssetSelection(tileSelection));
  }, [tileSelection, setCut]);

  const performCopy = useCallback(() => {
    if (tileSelection.size === 0) return;
    setCopy(selectionToAssetSelection(tileSelection));
  }, [tileSelection, setCopy]);

  const performPaste = useCallback(() => {
    if (!clipboard) return;
    const target = selectedFolderId === ROOT_FOLDER_ID ? null : selectedFolderId;
    if (clipboard.mode === 'cut') {
      moveAssets(clipboard.selection, target);
      clearClipboard();
      // Selection follows the moved items (same ids).
      const keys: SelectionKey[] = [
        ...clipboard.selection.subgraphIds.map(keyOfSubgraph),
        ...clipboard.selection.folderIds.map(keyOfFolder),
      ];
      replaceSelection(keys);
    } else {
      const newSel = pasteCopyAssets(clipboard.selection, target);
      const keys: SelectionKey[] = [
        ...newSel.subgraphIds.map(keyOfSubgraph),
        ...newSel.folderIds.map(keyOfFolder),
      ];
      if (keys.length > 0) replaceSelection(keys);
    }
  }, [clipboard, selectedFolderId, moveAssets, pasteCopyAssets, clearClipboard, replaceSelection]);

  const performSelectAll = useCallback(() => {
    if (visibleKeys.length === 0) return;
    setTileSelection(new Set(visibleKeys));
    anchorRef.current = visibleKeys[0]!;
  }, [visibleKeys]);

  // Register this panel's handle as the "active panel" so command-
  // palette entries can target it. The most-recently-focused panel
  // wins; clear on unmount.
  useEffect(() => {
    const handle: AssetPanelHandle = {
      performDelete,
      performDuplicate,
      performCut,
      performCopy,
      performPaste,
      performSelectAll,
    };
    setActiveAssetPanel(handle);
    return () => {
      if (getActiveAssetPanel() === handle) setActiveAssetPanel(null);
    };
  }, [performDelete, performDuplicate, performCut, performCopy, performPaste, performSelectAll]);

  // ----- Keyboard shortcuts (scoped to panel focus) -----
  // Mirrors node-canvas's window listener with an input-element guard
  // so text fields keep their own behavior. Additionally requires the
  // active element to be inside this panel's container, so multiple
  // AssetsPanels don't all respond to the same keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const active = document.activeElement;
      if (!active || !container.contains(active)) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return;

      const meta = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (clipboard) clearClipboard();
        else clearSelection();
        return;
      }
      if (!meta && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (tileSelection.size === 0) return;
        e.preventDefault();
        performDelete();
        return;
      }
      if (meta && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        performSelectAll();
        return;
      }
      if (meta && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        performDuplicate();
        return;
      }
      if (meta && (e.key === 'c' || e.key === 'C')) {
        if (tileSelection.size === 0) return;
        e.preventDefault();
        performCopy();
        return;
      }
      if (meta && (e.key === 'x' || e.key === 'X')) {
        if (tileSelection.size === 0) return;
        e.preventDefault();
        performCut();
        return;
      }
      if (meta && (e.key === 'v' || e.key === 'V')) {
        if (!clipboard) return;
        e.preventDefault();
        performPaste();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    tileSelection,
    clipboard,
    performDelete,
    performSelectAll,
    performDuplicate,
    performCut,
    performCopy,
    performPaste,
    clearSelection,
    clearClipboard,
  ]);

  const openContextMenu = (
    e: React.MouseEvent<HTMLElement>,
    target: AssetTarget,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    // Right-click on a tile NOT in the current selection: replace the
    // selection with that one tile, then open the menu. Right-click on
    // a tile that IS in the selection: keep the selection (the menu
    // operates on the whole set).
    if (target.kind === 'subgraph' || target.kind === 'folder') {
      const key =
        target.kind === 'subgraph' ? keyOfSubgraph(target.id) : keyOfFolder(target.id);
      if (!tileSelection.has(key)) {
        replaceSelection([key]);
      }
    }
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  };

  // ----- DnD -----
  // Build the drag payload from the current selection or a singleton
  // fallback. When the dragged tile isn't in the selection, the gesture
  // implicitly switches to dragging just that one — replicates Finder's
  // "drag-something-not-selected" behavior.
  const buildDragItems = useCallback(
    (origin: AssetDndItem): AssetDndItem[] => {
      const key =
        origin.kind === 'subgraph'
          ? keyOfSubgraph(origin.id)
          : origin.kind === 'folder'
            ? keyOfFolder(origin.id)
            : null;
      if (key === null || !tileSelection.has(key)) {
        // Main tiles, or tiles outside the current selection: just drag
        // the originating item.
        if (key !== null) {
          // Make the new singleton selection match the drag, for
          // consistency with click-and-drag in Finder.
          replaceSelection([key]);
        }
        return [origin];
      }
      // Drag the whole selection. Selection ordering is irrelevant for
      // drop targets that re-parent (folders) and Cartesian for
      // canvas-instantiate, so we just iterate the Set.
      const items: AssetDndItem[] = [];
      for (const k of tileSelection) {
        const d = decodeKey(k);
        items.push({ kind: d.kind, id: d.id });
      }
      return items;
    },
    [tileSelection, replaceSelection],
  );

  const onDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, origin: AssetDndItem) => {
      const items = buildDragItems(origin);
      e.dataTransfer.setData(ASSET_DND_TYPE, JSON.stringify(items));
      // copyMove because a single drag can land on different targets:
      //   • folder tile / tree row  → "move" (re-parent)
      //   • canvas                  → "copy" (instance the subgraph)
      //   • preview                 → "link" (pin this preview to it)
      // effectAllowed must include each target's chosen dropEffect or the
      // browser rejects the drop. 'all' is the catch-all.
      e.dataTransfer.effectAllowed = 'all';
    },
    [buildDragItems],
  );

  const onDragOverFolder = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };

  // Folder drop target: re-parent everything in the dragged payload to
  // the target folder (or root when `targetFolderId === null`).
  const onDropOnFolder = (
    e: React.DragEvent<HTMLDivElement>,
    targetFolderId: string | null,
  ) => {
    const raw = e.dataTransfer.getData(ASSET_DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const items = JSON.parse(raw) as AssetDndItem[];
      const selection: AssetSelection = { subgraphIds: [], folderIds: [] };
      for (const item of items) {
        if (item.kind === 'subgraph') selection.subgraphIds.push(item.id);
        else if (item.kind === 'folder') selection.folderIds.push(item.id);
      }
      moveAssets(selection, targetFolderId);
    } catch {
      /* malformed payload — ignore */
    }
  };

  // ----- Marquee select (icon view only) -----
  // Records the rectangle while the user drags from empty contents
  // space; on mouseup, intersects the rect against every
  // [data-asset-key] tile and replaces (or extends) the selection.
  const [marquee, setMarquee] = useState<null | {
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    additive: boolean;
    initialKeys: Set<SelectionKey>;
  }>(null);

  const onContentsMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only left-button drag from empty area; clicks on tiles handle
    // their own selection. Right-click is for context menus.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-asset-key]')) return;
    if (target.closest('.sedon-assets-rename')) return;
    // Take focus so keyboard shortcuts work after a click in the panel.
    containerRef.current?.focus({ preventScroll: true });
    // List view: a plain click on background clears the selection.
    // No marquee here — it'd fight scrolling.
    if (viewMode !== 'icons') {
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) clearSelection();
      return;
    }
    const rect = contentsRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const additive = e.metaKey || e.ctrlKey || e.shiftKey;
    setMarquee({
      startX,
      startY,
      curX: startX,
      curY: startY,
      additive,
      initialKeys: additive ? new Set(tileSelection) : new Set(),
    });
    if (!additive) clearSelection();
  };

  useEffect(() => {
    if (!marquee) return;
    const onMove = (e: MouseEvent) => {
      setMarquee((m) => (m ? { ...m, curX: e.clientX, curY: e.clientY } : m));
    };
    const onUp = () => {
      setMarquee(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMarquee(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onEsc);
    };
  }, [marquee]);

  // Live update of the selection while the marquee is dragging.
  // Recomputes intersection from scratch each frame for simplicity —
  // the tile count in any one folder is tiny so this is cheap.
  useEffect(() => {
    if (!marquee) return;
    const contents = contentsRef.current;
    if (!contents) return;
    const lo = {
      x: Math.min(marquee.startX, marquee.curX),
      y: Math.min(marquee.startY, marquee.curY),
    };
    const hi = {
      x: Math.max(marquee.startX, marquee.curX),
      y: Math.max(marquee.startY, marquee.curY),
    };
    const hit = new Set(marquee.initialKeys);
    const tiles = contents.querySelectorAll<HTMLElement>('[data-asset-key]');
    for (const tile of tiles) {
      const r = tile.getBoundingClientRect();
      if (r.right < lo.x || r.left > hi.x || r.bottom < lo.y || r.top > hi.y) continue;
      const key = tile.dataset.assetKey as SelectionKey | undefined;
      if (key) hit.add(key);
    }
    // Avoid re-render churn when the set didn't actually change.
    setTileSelection((prev) => {
      if (prev.size !== hit.size) return hit;
      for (const k of hit) if (!prev.has(k)) return hit;
      return prev;
    });
  }, [marquee]);

  // Marquee rect in container-relative coords for drawing.
  const marqueeStyle = useMemo(() => {
    if (!marquee) return null;
    const contents = contentsRef.current;
    if (!contents) return null;
    const base = contents.getBoundingClientRect();
    const left = Math.min(marquee.startX, marquee.curX) - base.left;
    const top = Math.min(marquee.startY, marquee.curY) - base.top;
    const width = Math.abs(marquee.curX - marquee.startX);
    const height = Math.abs(marquee.curY - marquee.startY);
    return { left, top, width, height };
  }, [marquee]);

  // Cut highlights: encode which keys are currently in the clipboard
  // as a Set the children can test for membership in O(1).
  const cutKeys = useMemo<Set<SelectionKey>>(() => {
    if (!clipboard || clipboard.mode !== 'cut') return new Set();
    const s = new Set<SelectionKey>();
    for (const id of clipboard.selection.subgraphIds) s.add(keyOfSubgraph(id));
    for (const id of clipboard.selection.folderIds) s.add(keyOfFolder(id));
    return s;
  }, [clipboard]);

  return (
    <div
      ref={containerRef}
      className="sedon-assets"
      tabIndex={0}
      onMouseDown={() => {
        // Click anywhere in the panel takes focus so keyboard shortcuts
        // work; don't fight existing tabIndex chains by stealing focus
        // from descendant text inputs.
        const active = document.activeElement as HTMLElement | null;
        if (active && containerRef.current?.contains(active)) return;
        containerRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="sedon-assets-toolbar">
        <button
          type="button"
          className="sedon-assets-toolbar-button"
          onClick={onNewFolderFromToolbar}
          title="Create a new folder in the current selection"
        >
          + New Folder
        </button>
        <div className="sedon-assets-toolbar-spacer" />
        <div className="sedon-assets-view-toggle" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'icons'}
            className={`sedon-assets-toolbar-button${viewMode === 'icons' ? ' sedon-assets-toolbar-button--active' : ''}`}
            onClick={() => setViewMode('icons')}
            title="Icon view"
          >
            ▦ Icons
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'list'}
            className={`sedon-assets-toolbar-button${viewMode === 'list' ? ' sedon-assets-toolbar-button--active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List view"
          >
            ☰ List
          </button>
        </div>
      </div>
      <div
        className="sedon-assets-body"
        ref={bodyRef}
        // Three-column grid: tree | divider | contents. The first
        // column's width is user-controlled via the divider; the
        // contents take the rest. Setting it inline (instead of via
        // a CSS variable) keeps the rule readable and means the
        // browser doesn't have to look up a custom property per
        // layout tick during the drag.
        style={{ gridTemplateColumns: `${treeWidth}px 4px 1fr` }}
      >
        <div
          className="sedon-assets-tree"
          // Drop on tree background = root.
          onDragOver={onDragOverFolder}
          onDrop={(e) => onDropOnFolder(e, null)}
          onContextMenu={(e) => openContextMenu(e, { kind: 'root' })}
        >
          <FolderTreeRow
            id={ROOT_FOLDER_ID}
            label="Project"
            depth={0}
            expanded={expanded.has(ROOT_FOLDER_ID)}
            selected={selectedFolderId === ROOT_FOLDER_ID}
            hasChildren={(index.get(ROOT_FOLDER_ID)?.childFolders.length ?? 0) > 0}
            onToggle={() => toggle(ROOT_FOLDER_ID)}
            onSelect={() => {
              setSelectedFolderId(ROOT_FOLDER_ID);
              clearSelection();
            }}
            isDraggable={false}
            renaming={false}
            isCut={false}
            onDragOver={onDragOverFolder}
            onDrop={(e) => onDropOnFolder(e, null)}
            onContextMenu={(e) => openContextMenu(e, { kind: 'root' })}
            onCommitRename={() => {}}
            onCancelRename={() => {}}
          />
          {expanded.has(ROOT_FOLDER_ID) &&
            renderFolderSubtree({
              index,
              parentId: null,
              depth: 1,
              expanded,
              selectedId: selectedFolderId,
              renaming,
              cutKeys,
              toggle,
              setSelected: (id) => {
                setSelectedFolderId(id);
                clearSelection();
              },
              onDragStart,
              onDragOver: onDragOverFolder,
              onDrop: onDropOnFolder,
              onContextMenu: openContextMenu,
              onCommitRename: (id, label) => {
                renameFolder(id, label);
                setRenaming(null);
              },
              onCancelRename: () => setRenaming(null),
            })}
        </div>
        <div
          className="sedon-assets-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize folder tree"
          onPointerDown={onDividerPointerDown}
        />
        <div
          ref={contentsRef}
          className="sedon-assets-contents"
          onMouseDown={onContentsMouseDown}
          onContextMenu={(e) => {
            // Background of the right pane: act like the selected
            // folder was the target so "New Folder" / "Paste" go there.
            if (e.target === e.currentTarget) {
              openContextMenu(e, { kind: 'folder', id: selectedFolderId });
            }
          }}
        >
          <AssetsContents
            folderId={selectedFolderId}
            index={index}
            viewMode={viewMode}
            renaming={renaming}
            tileSelection={tileSelection}
            cutKeys={cutKeys}
            onSelectFolder={(id) => {
              setSelectedFolderId(id);
              clearSelection();
            }}
            onTileClick={onTileClick}
            onDragStart={onDragStart}
            onDragOverFolder={onDragOverFolder}
            onDropOnFolder={onDropOnFolder}
            onOpenSubgraph={(id) => openGraphInCanvas(id)}
            onOpenMain={() => openGraphInCanvas(MAIN_GRAPH_ID)}
            onContextMenu={openContextMenu}
            onCommitRename={(t, label) => {
              if (t.kind === 'folder') renameFolder(t.id, label);
              else renameSubgraph(t.id, label);
              setRenaming(null);
            }}
            onCancelRename={() => setRenaming(null)}
          />
          {marquee && marqueeStyle && (
            <div className="sedon-assets-marquee" style={marqueeStyle} />
          )}
        </div>
      </div>
      {contextMenu && (
        <AssetContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          folderLookup={folders}
          subgraphLookup={subgraphs}
          selectionSize={tileSelection.size}
          clipboardKind={clipboard?.mode ?? null}
          onClose={() => setContextMenu(null)}
          onRename={(t) => {
            setRenaming(t);
            setContextMenu(null);
          }}
          onDelete={() => {
            performDelete();
            setContextMenu(null);
          }}
          onDuplicate={() => {
            performDuplicate();
            setContextMenu(null);
          }}
          onCut={() => {
            performCut();
            setContextMenu(null);
          }}
          onCopy={() => {
            performCopy();
            setContextMenu(null);
          }}
          onPaste={() => {
            performPaste();
            setContextMenu(null);
          }}
          onNewFolder={(parentId) => {
            onNewFolder(parentId);
            setContextMenu(null);
          }}
          onOpenSubgraph={(id) => {
            openGraphInCanvas(id);
            setContextMenu(null);
          }}
          onOpenMain={() => {
            openGraphInCanvas(MAIN_GRAPH_ID);
            setContextMenu(null);
          }}
          onOpenInPreview={(id) => {
            openGraphInPreview(id);
            setContextMenu(null);
          }}
        />
      )}
      {confirmDelete && (
        <DeleteConfirmDialog
          info={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteAssets(confirmDelete.selection);
            clearSelection();
            if (clipboard?.mode === 'cut') clearClipboard();
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

interface RenderSubtreeProps {
  index: ReturnType<typeof buildFolderIndex>;
  parentId: string | null;
  depth: number;
  expanded: Set<string>;
  selectedId: string;
  renaming: RenameTarget;
  cutKeys: ReadonlySet<SelectionKey>;
  toggle: (id: string) => void;
  setSelected: (id: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndItem) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, targetId: string | null) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>, target: AssetTarget) => void;
  onCommitRename: (id: string, label: string) => void;
  onCancelRename: () => void;
}

function renderFolderSubtree(p: RenderSubtreeProps): React.ReactNode[] {
  const folders = p.index.get(p.parentId ?? ROOT_FOLDER_ID)?.childFolders ?? [];
  return folders.flatMap((f) => {
    const isExpanded = p.expanded.has(f.id);
    const hasChildren = (p.index.get(f.id)?.childFolders.length ?? 0) > 0;
    const isRenaming =
      p.renaming?.kind === 'folder' && p.renaming.id === f.id;
    return [
      <FolderTreeRow
        key={f.id}
        id={f.id}
        label={f.label}
        depth={p.depth}
        expanded={isExpanded}
        selected={p.selectedId === f.id}
        hasChildren={hasChildren}
        onToggle={() => p.toggle(f.id)}
        onSelect={() => p.setSelected(f.id)}
        isDraggable
        renaming={isRenaming}
        isCut={p.cutKeys.has(keyOfFolder(f.id))}
        onDragStart={(e) => p.onDragStart(e, { kind: 'folder', id: f.id })}
        onDragOver={p.onDragOver}
        onDrop={(e) => p.onDrop(e, f.id)}
        onContextMenu={(e) => p.onContextMenu(e, { kind: 'folder', id: f.id })}
        onCommitRename={(label) => p.onCommitRename(f.id, label)}
        onCancelRename={p.onCancelRename}
      />,
      ...(isExpanded
        ? renderFolderSubtree({ ...p, parentId: f.id, depth: p.depth + 1 })
        : []),
    ];
  });
}

interface FolderTreeRowProps {
  id: string;
  label: string;
  depth: number;
  expanded: boolean;
  selected: boolean;
  hasChildren: boolean;
  onToggle: () => void;
  onSelect: () => void;
  isDraggable: boolean;
  renaming: boolean;
  isCut: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}

function FolderTreeRow(props: FolderTreeRowProps) {
  const cls =
    'sedon-assets-folder-row' +
    (props.selected ? ' sedon-assets-folder-row--selected' : '') +
    (props.isCut ? ' sedon-assets-folder-row--cut' : '');
  return (
    <div
      className={cls}
      style={{ paddingLeft: 4 + props.depth * 12 }}
      onClick={props.onSelect}
      draggable={props.isDraggable && !props.renaming}
      {...(props.onDragStart ? { onDragStart: props.onDragStart } : {})}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onContextMenu={props.onContextMenu}
    >
      <span
        className="sedon-assets-folder-twisty"
        onClick={(e) => {
          e.stopPropagation();
          if (props.hasChildren) props.onToggle();
        }}
      >
        {props.hasChildren ? (props.expanded ? '▾' : '▸') : ' '}
      </span>
      <span className="sedon-assets-folder-icon">📁</span>
      {props.renaming ? (
        <RenameInput
          initial={props.label}
          onCommit={props.onCommitRename}
          onCancel={props.onCancelRename}
        />
      ) : (
        <span className="sedon-assets-folder-label">{props.label}</span>
      )}
    </div>
  );
}

interface ContentsProps {
  folderId: string;
  index: ReturnType<typeof buildFolderIndex>;
  viewMode: ViewMode;
  renaming: RenameTarget;
  tileSelection: ReadonlySet<SelectionKey>;
  cutKeys: ReadonlySet<SelectionKey>;
  onSelectFolder: (id: string) => void;
  onTileClick: (key: SelectionKey, e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndItem) => void;
  onDragOverFolder: (e: React.DragEvent<HTMLDivElement>) => void;
  onDropOnFolder: (e: React.DragEvent<HTMLDivElement>, targetId: string | null) => void;
  onOpenSubgraph: (id: string) => void;
  onOpenMain: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>, target: AssetTarget) => void;
  onCommitRename: (target: { kind: 'folder' | 'subgraph'; id: string }, label: string) => void;
  onCancelRename: () => void;
}

function AssetsContents(p: ContentsProps) {
  const entry = p.index.get(p.folderId);
  if (!entry) {
    return <div className="sedon-assets-empty">Folder not found.</div>;
  }
  const { childFolders, subgraphs } = entry;
  // Main always shows at the project root, alongside top-level folders
  // and root-level subgraphs. It's never empty (a project always has a
  // main graph), so "Empty folder" never fires for the root.
  const showMain = p.folderId === ROOT_FOLDER_ID;
  if (!showMain && childFolders.length === 0 && subgraphs.length === 0) {
    return <div className="sedon-assets-empty">Empty folder.</div>;
  }
  const gridClass = `sedon-assets-grid sedon-assets-grid--${p.viewMode}`;
  return (
    <div className={gridClass}>
      {p.viewMode === 'list' && (
        <div className="sedon-assets-list-header">
          <span />
          <span>Name</span>
          <span>Type</span>
        </div>
      )}
      {showMain && (
        <MainTile
          viewMode={p.viewMode}
          onOpen={p.onOpenMain}
          onDragStart={(e) => p.onDragStart(e, { kind: 'main', id: MAIN_GRAPH_ID })}
          onContextMenu={(e) => p.onContextMenu(e, { kind: 'main', id: MAIN_GRAPH_ID })}
        />
      )}
      {childFolders.map((f) => {
        const isRenaming = p.renaming?.kind === 'folder' && p.renaming.id === f.id;
        const key = keyOfFolder(f.id);
        return (
          <FolderTile
            key={f.id}
            folder={f}
            viewMode={p.viewMode}
            renaming={isRenaming}
            selected={p.tileSelection.has(key)}
            isCut={p.cutKeys.has(key)}
            assetKey={key}
            onClick={(e) => p.onTileClick(key, e)}
            onOpen={() => p.onSelectFolder(f.id)}
            onDragStart={(e) => p.onDragStart(e, { kind: 'folder', id: f.id })}
            onDragOver={p.onDragOverFolder}
            onDrop={(e) => p.onDropOnFolder(e, f.id)}
            onContextMenu={(e) => p.onContextMenu(e, { kind: 'folder', id: f.id })}
            onCommitRename={(label) => p.onCommitRename({ kind: 'folder', id: f.id }, label)}
            onCancelRename={p.onCancelRename}
          />
        );
      })}
      {subgraphs.map((sg) => {
        const isRenaming = p.renaming?.kind === 'subgraph' && p.renaming.id === sg.id;
        const key = keyOfSubgraph(sg.id);
        return (
          <SubgraphTile
            key={sg.id}
            sg={sg}
            viewMode={p.viewMode}
            renaming={isRenaming}
            selected={p.tileSelection.has(key)}
            isCut={p.cutKeys.has(key)}
            assetKey={key}
            onClick={(e) => p.onTileClick(key, e)}
            onOpen={() => p.onOpenSubgraph(sg.id)}
            onDragStart={(e) => p.onDragStart(e, { kind: 'subgraph', id: sg.id })}
            onContextMenu={(e) => p.onContextMenu(e, { kind: 'subgraph', id: sg.id })}
            onCommitRename={(label) => p.onCommitRename({ kind: 'subgraph', id: sg.id }, label)}
            onCancelRename={p.onCancelRename}
          />
        );
      })}
    </div>
  );
}

function tileClass(
  viewMode: ViewMode,
  kind: 'folder' | 'subgraph' | 'main',
  selected: boolean,
  isCut: boolean,
): string {
  return (
    `sedon-assets-tile sedon-assets-tile--${viewMode} sedon-assets-tile--${kind}` +
    (selected ? ' sedon-assets-tile--selected' : '') +
    (isCut ? ' sedon-assets-tile--cut' : '')
  );
}

interface FolderTileProps {
  folder: Folder;
  viewMode: ViewMode;
  renaming: boolean;
  selected: boolean;
  isCut: boolean;
  assetKey: SelectionKey;
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}

function FolderTile(p: FolderTileProps) {
  return (
    <div
      className={tileClass(p.viewMode, 'folder', p.selected, p.isCut)}
      data-asset-key={p.assetKey}
      onClick={p.onClick}
      onDoubleClick={p.onOpen}
      draggable={!p.renaming}
      onDragStart={p.onDragStart}
      // Folder tiles in the grid are ALSO drop targets — drop a
      // subgraph or another folder onto one to re-parent it.
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      onContextMenu={p.onContextMenu}
      title="Double-click to enter; drop items here to move them in"
    >
      <span className="sedon-assets-tile-icon">📁</span>
      {p.renaming ? (
        <RenameInput
          initial={p.folder.label}
          onCommit={p.onCommitRename}
          onCancel={p.onCancelRename}
        />
      ) : (
        <span className="sedon-assets-tile-label">{p.folder.label}</span>
      )}
      <span className="sedon-assets-tile-type">Folder</span>
    </div>
  );
}

interface MainTileProps {
  viewMode: ViewMode;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
}

// The project's root graph rendered as a fixed asset at the root of the
// tree. Operations are a strict subset of SubgraphTile's:
//   • double-click → switch the active canvas to main
//   • drag → preview-only (drop on Preview to pin; canvas drop is a no-op
//     because main can't be instanced as a wrapper)
//   • right-click → context menu with "Open in Canvas"
//   • no rename, no delete, no folder re-parent, no multi-select
function MainTile(p: MainTileProps) {
  const icon =
    p.viewMode === 'icons' ? (
      <AssetThumbnail
        target={{ kind: 'main' }}
        size={THUMBNAIL_PX}
        fallback={<span className="sedon-assets-tile-icon">◉</span>}
      />
    ) : (
      <span className="sedon-assets-tile-icon">◉</span>
    );
  return (
    <div
      className={`sedon-assets-tile sedon-assets-tile--${p.viewMode} sedon-assets-tile--main`}
      onDoubleClick={p.onOpen}
      draggable
      onDragStart={p.onDragStart}
      onContextMenu={p.onContextMenu}
      title="The project's main graph. Double-click to edit; drop on a Preview to pin to it."
    >
      {icon}
      <span className="sedon-assets-tile-label">Main</span>
      <span className="sedon-assets-tile-type">Main</span>
    </div>
  );
}

interface SubgraphTileProps {
  sg: SubgraphDef;
  viewMode: ViewMode;
  renaming: boolean;
  selected: boolean;
  isCut: boolean;
  assetKey: SelectionKey;
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}

function SubgraphTile(p: SubgraphTileProps) {
  // Icon-mode tiles get a live preview thumbnail (auto-framed to the
  // subgraph's output). List mode keeps the static diamond glyph — at
  // list-row height a 14px rendered scene is just noise.
  const icon =
    p.viewMode === 'icons' ? (
      <AssetThumbnail
        target={{ kind: 'subgraph', subgraphId: p.sg.id }}
        size={THUMBNAIL_PX}
        fallback={<span className="sedon-assets-tile-icon">◇</span>}
      />
    ) : (
      <span className="sedon-assets-tile-icon">◇</span>
    );
  const typeLabel = subgraphTypeLabel(p.sg);
  return (
    <div
      className={tileClass(p.viewMode, 'subgraph', p.selected, p.isCut)}
      data-asset-key={p.assetKey}
      onClick={p.onClick}
      onDoubleClick={p.onOpen}
      draggable={!p.renaming}
      onDragStart={p.onDragStart}
      onContextMenu={p.onContextMenu}
      title={`Drag onto a canvas to instance this subgraph; double-click to edit (outputs: ${typeLabel})`}
    >
      {icon}
      {p.renaming ? (
        <RenameInput
          initial={p.sg.label}
          onCommit={p.onCommitRename}
          onCancel={p.onCancelRename}
        />
      ) : (
        <span className="sedon-assets-tile-label">{p.sg.label}</span>
      )}
      <span className="sedon-assets-tile-type">{typeLabel}</span>
    </div>
  );
}

// Human-readable summary of a subgraph's output types for the asset
// view's "Type" column. We deliberately use OUTPUT types here (what a
// caller sees when they wire the wrapper) rather than input types —
// the asset is what the subgraph produces.
//
//   • no outputs       → "Subgraph"  (fallback, shouldn't normally happen)
//   • one type         → that type (e.g. "Scene")
//   • two unique types → "Scene, Texture2D"
//   • three or more    → "Scene, Texture2D, ..."
function subgraphTypeLabel(sg: SubgraphDef): string {
  if (sg.outputs.length === 0) return 'Subgraph';
  const seen: string[] = [];
  for (const o of sg.outputs) {
    if (!seen.includes(o.type)) seen.push(o.type);
  }
  if (seen.length === 1) return seen[0]!;
  if (seen.length === 2) return seen.join(', ');
  return `${seen[0]}, ${seen[1]}, ...`;
}

// Inline-rename text field. Enter / blur commits; Escape cancels; Esc
// also cancels through the keyDown handler so the field can sit inside
// a clickable row without click-handling getting in the way.
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      className="sedon-assets-rename"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onCommit(value);
        else if (e.key === 'Escape') onCancel();
      }}
    />
  );
}

// Right-click context menu. The item set depends on the target kind and
// whether the current selection is one item or many:
//   • subgraph / folder (single) → Rename, Duplicate, Cut, Copy, Delete,
//                                  Open / Open in Preview
//   • subgraph / folder (multi)  → Duplicate, Cut, Copy, Delete
//   • main                       → Open in Canvas, Open in Preview
//   • root / folder background   → New Folder, Paste (when clipboard)
function AssetContextMenu({
  x,
  y,
  target,
  folderLookup,
  subgraphLookup,
  selectionSize,
  clipboardKind,
  onClose,
  onRename,
  onDelete,
  onDuplicate,
  onCut,
  onCopy,
  onPaste,
  onNewFolder,
  onOpenSubgraph,
  onOpenMain,
  onOpenInPreview,
}: {
  x: number;
  y: number;
  target: AssetTarget;
  folderLookup: ReadonlyArray<Folder>;
  subgraphLookup: ReadonlyArray<SubgraphDef>;
  selectionSize: number;
  clipboardKind: 'cut' | 'copy' | null;
  onClose: () => void;
  onRename: (t: { kind: 'folder' | 'subgraph'; id: string }) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onNewFolder: (parentId: string | null) => void;
  onOpenSubgraph: (id: string) => void;
  onOpenMain: () => void;
  onOpenInPreview: (graphId: string) => void;
}) {
  // Pre-resolve labels so the menu can show the target name in its
  // title row.
  let title = 'Project';
  if (target.kind === 'folder') {
    const f = folderLookup.find((x) => x.id === target.id);
    if (f) title = f.label;
    else if (target.id === ROOT_FOLDER_ID) title = 'Project';
  } else if (target.kind === 'subgraph') {
    const s = subgraphLookup.find((x) => x.id === target.id);
    if (s) title = s.label;
  } else if (target.kind === 'main') {
    title = 'Main';
  }
  const multi = selectionSize > 1;
  if (multi) title = `${selectionSize} items selected`;

  const items: { label: string; action: () => void; disabled?: boolean }[] = [];
  if (target.kind === 'subgraph') {
    if (!multi) {
      items.push({ label: 'Rename', action: () => onRename({ kind: 'subgraph', id: target.id }) });
      items.push({ label: 'Open in Canvas', action: () => onOpenSubgraph(target.id) });
      items.push({ label: 'Open in Preview', action: () => onOpenInPreview(target.id) });
      items.push({ label: '---', action: () => {} });
    }
    items.push({ label: multi ? 'Duplicate' : 'Duplicate', action: onDuplicate });
    items.push({ label: 'Cut', action: onCut });
    items.push({ label: 'Copy', action: onCopy });
    items.push({ label: 'Delete', action: onDelete });
  } else if (target.kind === 'main') {
    items.push({ label: 'Open in Canvas', action: () => onOpenMain() });
    items.push({ label: 'Open in Preview', action: () => onOpenInPreview('main') });
  } else if (target.kind === 'folder') {
    const isRoot = target.id === ROOT_FOLDER_ID;
    if (!multi && !isRoot) {
      items.push({ label: 'Rename', action: () => onRename({ kind: 'folder', id: target.id }) });
    }
    if (!isRoot) {
      items.push({ label: 'Duplicate', action: onDuplicate });
      items.push({ label: 'Cut', action: onCut });
      items.push({ label: 'Copy', action: onCopy });
      items.push({ label: 'Delete', action: onDelete });
      items.push({ label: '---', action: () => {} });
    }
    items.push({
      label: 'New Folder Inside',
      action: () => onNewFolder(isRoot ? null : target.id),
    });
    items.push({
      label: 'Paste',
      action: onPaste,
      disabled: clipboardKind === null,
    });
  } else {
    // Root tree-background.
    items.push({ label: 'New Folder', action: () => onNewFolder(null) });
    items.push({ label: 'Paste', action: onPaste, disabled: clipboardKind === null });
  }

  return (
    <div
      className="sedon-assets-context-menu"
      style={{ left: x, top: y }}
      // Eat the click so the global mousedown listener doesn't dismiss
      // the menu before the chosen item's onClick fires.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="sedon-assets-context-menu-title">{title}</div>
      {items.map((item, i) =>
        item.label === '---' ? (
          <div key={`sep-${i}`} className="sedon-assets-context-menu-sep" />
        ) : (
          <button
            key={item.label}
            type="button"
            disabled={item.disabled}
            className="sedon-assets-context-menu-item"
            onClick={(e) => {
              e.stopPropagation();
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

// Modal shown before a delete that would dangle wrapper references.
// Plain centered overlay; mounts inside the panel so DockView's
// per-panel scoping keeps it visually anchored.
function DeleteConfirmDialog({
  info,
  onCancel,
  onConfirm,
}: {
  info: { selection: AssetSelection; refs: number; graphs: number };
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);
  const totalItems = info.selection.subgraphIds.length + info.selection.folderIds.length;
  return (
    <div className="sedon-assets-dialog-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sedon-assets-dialog">
        <div className="sedon-assets-dialog-title">Delete {totalItems} item{totalItems === 1 ? '' : 's'}?</div>
        <div className="sedon-assets-dialog-body">
          {info.refs} wrapper {info.refs === 1 ? 'node references' : 'nodes reference'} the
          subgraph{info.selection.subgraphIds.length === 1 ? '' : 's'} you're about to delete,
          across {info.graphs} {info.graphs === 1 ? 'graph' : 'graphs'}. Those wrappers will
          stop producing output. Undo restores everything.
        </div>
        <div className="sedon-assets-dialog-buttons">
          <button
            ref={cancelRef}
            type="button"
            className="sedon-assets-dialog-button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="sedon-assets-dialog-button sedon-assets-dialog-button--danger"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
