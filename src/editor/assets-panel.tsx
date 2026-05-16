import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  buildFolderIndex,
  ROOT_FOLDER_ID,
  type Folder,
} from '../core/folder.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { AssetThumbnail } from './asset-thumbnail.js';
import { useEditorStore } from './store.js';

// Pixel size of the live subgraph preview shown in icon-view tiles.
// Matches roughly the natural tile width set by the icon-grid CSS so
// the canvas isn't upscaled past its rendered size.
const THUMBNAIL_PX = 64;

// Drag-and-drop MIME type for asset moves. Payload is a JSON
// `{ kind: 'folder' | 'subgraph' | 'main', id: string }`. The Asset view
// reads this for re-parenting; NodeCanvasPanel reads it for "drop into
// graph" (subgraph-only — main can't be instanced); Preview reads it to
// pin (subgraph or main).
//
// The synthetic 'main' kind carries `id: 'main'` so consumers that key
// on id (preview pin, etc.) work without a separate code path.
export const ASSET_DND_TYPE = 'application/sedon-asset';

export interface AssetDndPayload {
  kind: 'folder' | 'subgraph' | 'main';
  id: string;
}

// The id used by the preview pin / GraphSwitcher for the project's root
// graph. Mirrors the literal used in store.ts and preview.tsx — kept
// here so the asset view doesn't have to import either one just to make
// a drag payload.
const MAIN_GRAPH_ID = 'main';

type AssetTarget = AssetDndPayload | { kind: 'root' };
type ViewMode = 'icons' | 'list';
type RenameTarget = { kind: 'folder' | 'subgraph'; id: string } | null;
type ContextMenu = {
  x: number;
  y: number;
  target: AssetTarget;
} | null;

// =========================================================================
// AssetsPanel — Unity-style two-pane Project view with rename, context
// menu, and Icons / List view modes.
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
// Right-click any row/tile for Rename / Delete / New Folder.
// =========================================================================
export function AssetsPanel() {
  const folders = useEditorStore((s) => s.folders);
  const subgraphs = useEditorStore(useShallow((s) => s.subgraphs));
  const createFolder = useEditorStore((s) => s.createFolder);
  const deleteFolder = useEditorStore((s) => s.deleteFolder);
  const moveSubgraphToFolder = useEditorStore((s) => s.moveSubgraphToFolder);
  const moveFolderToFolder = useEditorStore((s) => s.moveFolderToFolder);
  const renameFolder = useEditorStore((s) => s.renameFolder);
  const renameSubgraph = useEditorStore((s) => s.renameSubgraph);
  const setActiveEditing = useEditorStore((s) => s.setActiveEditing);

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

  // F2 → rename the current selection. Ignored while typing in an
  // input/textarea so it doesn't fight with text editing elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      )
        return;
      if (selectedFolderId === ROOT_FOLDER_ID) return;
      setRenaming({ kind: 'folder', id: selectedFolderId });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFolderId]);

  const index = useMemo(
    () => buildFolderIndex(folders, subgraphs),
    [folders, subgraphs],
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

  const openContextMenu = (
    e: React.MouseEvent<HTMLElement>,
    target: AssetTarget,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  };

  // ----- DnD -----
  const onDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    payload: AssetDndPayload,
  ) => {
    e.dataTransfer.setData(ASSET_DND_TYPE, JSON.stringify(payload));
    // copyMove because a single drag can land on different targets:
    //   • folder tile / tree row  → "move" (re-parent)
    //   • canvas                  → "copy" (instance the subgraph)
    //   • preview                 → "link" (pin this preview to it)
    // effectAllowed must include each target's chosen dropEffect or the
    // browser rejects the drop. 'all' is the catch-all.
    e.dataTransfer.effectAllowed = 'all';
  };

  const onDragOverFolder = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };

  // Folder drop target: re-parent the dragged item into this folder
  // (or root when `targetFolderId === null`).
  const onDropOnFolder = (
    e: React.DragEvent<HTMLDivElement>,
    targetFolderId: string | null,
  ) => {
    const raw = e.dataTransfer.getData(ASSET_DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const payload = JSON.parse(raw) as AssetDndPayload;
      if (payload.kind === 'subgraph') {
        moveSubgraphToFolder(payload.id, targetFolderId);
      } else if (payload.kind === 'folder') {
        moveFolderToFolder(payload.id, targetFolderId);
      }
    } catch {
      /* malformed payload — ignore */
    }
  };

  return (
    <div className="sedon-assets">
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
      <div className="sedon-assets-body">
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
            onSelect={() => setSelectedFolderId(ROOT_FOLDER_ID)}
            // Root accepts drops but isn't itself draggable or renameable.
            isDraggable={false}
            renaming={false}
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
              toggle,
              setSelected: setSelectedFolderId,
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
          className="sedon-assets-contents"
          onContextMenu={(e) => {
            // Background of the right pane: act like the selected
            // folder was the target so "New Folder" goes there.
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
            onSelectFolder={setSelectedFolderId}
            onDragStart={onDragStart}
            onDragOverFolder={onDragOverFolder}
            onDropOnFolder={onDropOnFolder}
            onOpenSubgraph={(id) => setActiveEditing(id)}
            onOpenMain={() => setActiveEditing(MAIN_GRAPH_ID)}
            onContextMenu={openContextMenu}
            onCommitRename={(t, label) => {
              if (t.kind === 'folder') renameFolder(t.id, label);
              else renameSubgraph(t.id, label);
              setRenaming(null);
            }}
            onCancelRename={() => setRenaming(null)}
          />
        </div>
      </div>
      {contextMenu && (
        <AssetContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          folderLookup={folders}
          subgraphLookup={subgraphs}
          onClose={() => setContextMenu(null)}
          onRename={(t) => {
            setRenaming(t);
            setContextMenu(null);
          }}
          onDelete={(folderId) => {
            deleteFolder(folderId);
            setContextMenu(null);
            if (selectedFolderId === folderId) setSelectedFolderId(ROOT_FOLDER_ID);
          }}
          onNewFolder={(parentId) => {
            onNewFolder(parentId);
            setContextMenu(null);
          }}
          onOpenSubgraph={(id) => {
            setActiveEditing(id);
            setContextMenu(null);
          }}
          onOpenMain={() => {
            setActiveEditing(MAIN_GRAPH_ID);
            setContextMenu(null);
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
  toggle: (id: string) => void;
  setSelected: (id: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndPayload) => void;
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
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
  onCommitRename: (label: string) => void;
  onCancelRename: () => void;
}

function FolderTreeRow(props: FolderTreeRowProps) {
  return (
    <div
      className={`sedon-assets-folder-row${props.selected ? ' sedon-assets-folder-row--selected' : ''}`}
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
  onSelectFolder: (id: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndPayload) => void;
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
        return (
          <FolderTile
            key={f.id}
            folder={f}
            viewMode={p.viewMode}
            renaming={isRenaming}
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
        return (
          <SubgraphTile
            key={sg.id}
            sg={sg}
            viewMode={p.viewMode}
            renaming={isRenaming}
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

interface FolderTileProps {
  folder: Folder;
  viewMode: ViewMode;
  renaming: boolean;
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
      className={`sedon-assets-tile sedon-assets-tile--${p.viewMode} sedon-assets-tile--folder`}
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
//   • no rename, no delete, no folder re-parent
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
      className={`sedon-assets-tile sedon-assets-tile--${p.viewMode} sedon-assets-tile--subgraph`}
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

// Right-click context menu. Item set depends on the target kind:
//   • subgraph → Rename, Open in Canvas
//   • main     → Open in Canvas (only; main is fixed and unique)
//   • folder   → Rename, Delete, New Folder Inside
//   • root     → New Folder
function AssetContextMenu({
  x,
  y,
  target,
  folderLookup,
  subgraphLookup,
  onClose,
  onRename,
  onDelete,
  onNewFolder,
  onOpenSubgraph,
  onOpenMain,
}: {
  x: number;
  y: number;
  target: AssetTarget;
  folderLookup: ReadonlyArray<Folder>;
  subgraphLookup: ReadonlyArray<SubgraphDef>;
  onClose: () => void;
  onRename: (t: { kind: 'folder' | 'subgraph'; id: string }) => void;
  onDelete: (folderId: string) => void;
  onNewFolder: (parentId: string | null) => void;
  onOpenSubgraph: (id: string) => void;
  onOpenMain: () => void;
}) {
  // Pre-resolve labels so the menu can show the target name in its
  // title row — small nicety, helps when the same right-click hit the
  // wrong row by accident.
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
  const items: { label: string; action: () => void; disabled?: boolean }[] = [];
  if (target.kind === 'subgraph') {
    items.push(
      { label: 'Rename', action: () => onRename({ kind: 'subgraph', id: target.id }) },
      { label: 'Open in Canvas', action: () => onOpenSubgraph(target.id) },
    );
  } else if (target.kind === 'main') {
    items.push({ label: 'Open in Canvas', action: () => onOpenMain() });
  } else if (target.kind === 'folder') {
    const isRoot = target.id === ROOT_FOLDER_ID;
    items.push(
      {
        label: 'Rename',
        action: () => onRename({ kind: 'folder', id: target.id }),
        disabled: isRoot,
      },
      {
        label: 'Delete',
        action: () => onDelete(target.id),
        disabled: isRoot,
      },
      {
        label: 'New Folder Inside',
        action: () => onNewFolder(isRoot ? null : target.id),
      },
    );
  } else {
    items.push({ label: 'New Folder', action: () => onNewFolder(null) });
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
      {items.map((item) => (
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
      ))}
    </div>
  );
}
