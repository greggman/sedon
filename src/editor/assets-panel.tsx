import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  buildFolderIndex,
  ROOT_FOLDER_ID,
  type Folder,
} from '../core/folder.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { useEditorStore } from './store.js';

// Drag-and-drop MIME type for asset moves. Payload is a JSON
// `{ kind: 'folder' | 'subgraph', id: string }`. The Asset view reads
// this for re-parenting; NodeCanvasPanel reads it for "drop into graph"
// (subgraph-only).
export const ASSET_DND_TYPE = 'application/sedon-asset';

export interface AssetDndPayload {
  kind: 'folder' | 'subgraph';
  id: string;
}

// =========================================================================
// AssetsPanel — Unity-style two-pane Project view.
//
//   ┌─────────────────────────┬──────────────────────────────────────────┐
//   │ Folder tree (left)      │ Selected folder's contents (right)       │
//   │                         │                                          │
//   │ ▾ Root                  │ ▸ Trees                                  │
//   │   ▸ Trees               │ ◇ Bark Texture                           │
//   │   ▸ Bushes              │ ◇ Oak leaf                               │
//   │                         │                                          │
//   └─────────────────────────┴──────────────────────────────────────────┘
//
// Left tree shows folders only (matches Unity's Project window). Right
// pane shows the selected folder's immediate folder + subgraph
// children. Dragging within the asset view re-parents; dragging a
// subgraph row onto a canvas adds a wrapper of that subgraph at the
// drop point (cycle-checked in node-canvas.tsx).
// =========================================================================
export function AssetsPanel() {
  const folders = useEditorStore((s) => s.folders);
  const subgraphs = useEditorStore(useShallow((s) => s.subgraphs));
  const createFolder = useEditorStore((s) => s.createFolder);
  const deleteFolder = useEditorStore((s) => s.deleteFolder);
  const moveSubgraphToFolder = useEditorStore((s) => s.moveSubgraphToFolder);
  const moveFolderToFolder = useEditorStore((s) => s.moveFolderToFolder);
  const setActiveEditing = useEditorStore((s) => s.setActiveEditing);

  // Tree expansion state (purely UI; not persisted).
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

  const index = useMemo(
    () => buildFolderIndex(folders, subgraphs),
    [folders, subgraphs],
  );

  const onNewFolder = () => {
    const parent =
      selectedFolderId === ROOT_FOLDER_ID ? null : selectedFolderId;
    const label = `New Folder ${folders.length + 1}`;
    const newId = createFolder(parent, label);
    setExpanded((prev) => {
      const next = new Set(prev);
      // Auto-expand the parent so the new folder is visible.
      next.add(parent ?? ROOT_FOLDER_ID);
      next.add(newId);
      return next;
    });
    setSelectedFolderId(newId);
  };

  // Drag handlers shared between the tree and the right-pane rows.
  const onDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    payload: AssetDndPayload,
  ) => {
    e.dataTransfer.setData(ASSET_DND_TYPE, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
  };

  // Folder drop target: re-parent the dragged item into this folder.
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

  const onDragOverFolder = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  };

  return (
    <div className="sedon-assets">
      <div className="sedon-assets-toolbar">
        <button
          type="button"
          className="sedon-assets-toolbar-button"
          onClick={onNewFolder}
          title="Create a new folder at the current selection"
        >
          + New Folder
        </button>
      </div>
      <div className="sedon-assets-body">
        <div
          className="sedon-assets-tree"
          // Drop on tree background = root.
          onDragOver={onDragOverFolder}
          onDrop={(e) => onDropOnFolder(e, null)}
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
            // Root accepts drops but isn't itself draggable.
            isDraggable={false}
            onDragOver={onDragOverFolder}
            onDrop={(e) => onDropOnFolder(e, null)}
          />
          {expanded.has(ROOT_FOLDER_ID) &&
            renderFolderSubtree(
              index,
              null,
              1,
              expanded,
              selectedFolderId,
              toggle,
              setSelectedFolderId,
              onDragStart,
              onDragOverFolder,
              onDropOnFolder,
            )}
        </div>
        <div className="sedon-assets-contents">
          <AssetsContents
            folderId={selectedFolderId}
            index={index}
            onSelectFolder={setSelectedFolderId}
            onDragStart={onDragStart}
            onOpenSubgraph={(id) => setActiveEditing(id)}
            onDeleteFolder={deleteFolder}
          />
        </div>
      </div>
    </div>
  );
}

function renderFolderSubtree(
  index: ReturnType<typeof buildFolderIndex>,
  parentId: string | null,
  depth: number,
  expanded: Set<string>,
  selectedId: string,
  toggle: (id: string) => void,
  setSelected: (id: string) => void,
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndPayload) => void,
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void,
  onDrop: (e: React.DragEvent<HTMLDivElement>, targetId: string | null) => void,
): React.ReactNode[] {
  const folders = index.get(parentId ?? ROOT_FOLDER_ID)?.childFolders ?? [];
  return folders.flatMap((f) => {
    const isExpanded = expanded.has(f.id);
    const hasChildren = (index.get(f.id)?.childFolders.length ?? 0) > 0;
    return [
      <FolderTreeRow
        key={f.id}
        id={f.id}
        label={f.label}
        depth={depth}
        expanded={isExpanded}
        selected={selectedId === f.id}
        hasChildren={hasChildren}
        onToggle={() => toggle(f.id)}
        onSelect={() => setSelected(f.id)}
        isDraggable
        onDragStart={(e) => onDragStart(e, { kind: 'folder', id: f.id })}
        onDragOver={onDragOver}
        onDrop={(e) => onDrop(e, f.id)}
      />,
      ...(isExpanded
        ? renderFolderSubtree(
            index,
            f.id,
            depth + 1,
            expanded,
            selectedId,
            toggle,
            setSelected,
            onDragStart,
            onDragOver,
            onDrop,
          )
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
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

function FolderTreeRow(props: FolderTreeRowProps) {
  return (
    <div
      className={`sedon-assets-folder-row${props.selected ? ' sedon-assets-folder-row--selected' : ''}`}
      style={{ paddingLeft: 4 + props.depth * 12 }}
      onClick={props.onSelect}
      draggable={props.isDraggable}
      {...(props.onDragStart ? { onDragStart: props.onDragStart } : {})}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
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
      <span className="sedon-assets-folder-label">{props.label}</span>
    </div>
  );
}

interface ContentsProps {
  folderId: string;
  index: ReturnType<typeof buildFolderIndex>;
  onSelectFolder: (id: string) => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, p: AssetDndPayload) => void;
  onOpenSubgraph: (id: string) => void;
  onDeleteFolder: (id: string) => void;
}

function AssetsContents({
  folderId,
  index,
  onSelectFolder,
  onDragStart,
  onOpenSubgraph,
  onDeleteFolder,
}: ContentsProps) {
  const entry = index.get(folderId);
  if (!entry) {
    return <div className="sedon-assets-empty">Folder not found.</div>;
  }
  const { childFolders, subgraphs } = entry;
  if (childFolders.length === 0 && subgraphs.length === 0) {
    return <div className="sedon-assets-empty">Empty folder.</div>;
  }
  return (
    <div className="sedon-assets-grid">
      {childFolders.map((f) => (
        <FolderTile
          key={f.id}
          folder={f}
          onOpen={() => onSelectFolder(f.id)}
          onDragStart={(e) => onDragStart(e, { kind: 'folder', id: f.id })}
          onDelete={() => onDeleteFolder(f.id)}
        />
      ))}
      {subgraphs.map((sg) => (
        <SubgraphTile
          key={sg.id}
          sg={sg}
          onOpen={() => onOpenSubgraph(sg.id)}
          onDragStart={(e) => onDragStart(e, { kind: 'subgraph', id: sg.id })}
        />
      ))}
    </div>
  );
}

function FolderTile({
  folder,
  onOpen,
  onDragStart,
  onDelete,
}: {
  folder: Folder;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="sedon-assets-tile sedon-assets-tile--folder"
      onDoubleClick={onOpen}
      draggable
      onDragStart={onDragStart}
      title="Double-click to enter"
    >
      <span className="sedon-assets-tile-icon">📁</span>
      <span className="sedon-assets-tile-label">{folder.label}</span>
      <button
        type="button"
        className="sedon-assets-tile-action"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete folder (contents move up one level)"
      >
        ×
      </button>
    </div>
  );
}

function SubgraphTile({
  sg,
  onOpen,
  onDragStart,
}: {
  sg: SubgraphDef;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className="sedon-assets-tile sedon-assets-tile--subgraph"
      onDoubleClick={onOpen}
      draggable
      onDragStart={onDragStart}
      title="Drag onto a canvas to instance this subgraph; double-click to edit"
    >
      <span className="sedon-assets-tile-icon">◇</span>
      <span className="sedon-assets-tile-label">{sg.label}</span>
    </div>
  );
}
