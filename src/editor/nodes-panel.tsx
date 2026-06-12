import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeDef } from '../core/node-def.js';
import { docsUrlFor } from '../docs/doc-paths.js';
import { CORE_NODES } from '../nodes/index.js';
import { useLayoutStore } from './layout-store.js';
import { categoryColorFor, getNodeIcon, hasNodeIcon } from './node-icons.js';
import { outputBarBackground } from './node-output-color.js';
import { NodeThumbnail } from './node-thumbnail.js';

// =========================================================================
// NodesPanel — Phase 1 of the Node Browser
//
// A read-only browser over the core node registry, structured to mirror
// AssetsPanel's two-pane layout so the visual model is familiar:
//
//   ┌──────────────┬──────────────────────────────────────────┐
//   │ Category tree│ Selected category's nodes                │
//   │              │ ╔═════════╗ ╔═════════╗ ╔═════════╗      │
//   │ ▾ All Nodes  │ ║ ◇        ║ ║ ◇        ║ ║ ◇        ║   │
//   │   ▾ Texture  │ ║ tex/grid ║ ║ tex/brick║ ║ tex/dots ║   │
//   │   ▸ Geometry │ ╚═════════╝ ╚═════════╝ ╚═════════╝      │
//   │              │                                          │
//   └──────────────┴──────────────────────────────────────────┘
//
// Selecting any tree node shows ALL leaves under that subtree (root shows
// every core node; a top-level category shows everything under it; a
// sub-category shows just its direct children).
//
// Drag a tile onto a canvas to instantiate that node kind at the drop
// position. The drag payload uses a distinct MIME from AssetsPanel so
// the canvas can tell node-kind drops apart from subgraph-instance drops.
//
// This panel reuses the AssetsPanel CSS classes (sedon-assets-*) since
// the visual is identical — same tree, same tile grid, same divider.
// If the two panels' styling diverges later, the classes can be
// renamed/copied at that point. The internal logic does NOT share with
// AssetsPanel because the mutation model differs entirely (no rename /
// cut / paste / delete on a static registry).
// =========================================================================

// Distinct MIME from ASSET_DND_TYPE so the canvas can route the drop:
//   • ASSET_DND_TYPE     → subgraph wrapper instance
//   • NODE_KIND_DND_TYPE → core node by kind id
export const NODE_KIND_DND_TYPE = 'application/sedon-node-kind';

export interface NodeKindDndItem {
  kind: string;
}

// Synthetic root id for the tree, distinct from any real category so
// selection can encode "show everything".
const ROOT_KEY = '__root';

interface CategoryNode {
  // Encoded selection key (path with '/' separators below the root).
  key: string;
  // Display label (last segment for sub-categories, full for tops).
  label: string;
  // Depth from root (root = 0, top category = 1, sub-category = 2…).
  depth: number;
  // Child category keys, in display order.
  children: string[];
  // Direct leaf nodes in this exact category (not transitive).
  directNodes: NodeDef[];
  // ALL leaf nodes at or below this category, in display order.
  // Pre-computed so the right pane never has to walk the tree.
  allNodes: NodeDef[];
}

// Build a tree from CORE_NODES' category strings. Categories are
// path-separated ('Texture/Generators') so we parse them into a
// hierarchical map. Single-segment categories ('Math', 'Animation')
// become top-level categories with no sub-categories.
function buildCategoryTree(nodes: ReadonlyArray<NodeDef>): Map<string, CategoryNode> {
  const tree = new Map<string, CategoryNode>();
  // Always present so root selection works even with zero nodes.
  tree.set(ROOT_KEY, {
    key: ROOT_KEY,
    label: 'All Nodes',
    depth: 0,
    children: [],
    directNodes: [],
    allNodes: [],
  });

  // First pass: ensure every prefix path has a CategoryNode.
  for (const def of nodes) {
    const segments = def.category.split('/').filter((s) => s.length > 0);
    let parentKey = ROOT_KEY;
    let path = '';
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      path = path === '' ? segment : `${path}/${segment}`;
      if (!tree.has(path)) {
        tree.set(path, {
          key: path,
          label: segment,
          depth: i + 1,
          children: [],
          directNodes: [],
          allNodes: [],
        });
        const parent = tree.get(parentKey)!;
        if (!parent.children.includes(path)) parent.children.push(path);
      }
      parentKey = path;
    }
    // Leaf landing: attach to the deepest category, or root for
    // category-less nodes (shouldn't happen with CORE_NODES, but
    // defensive).
    const leafKey = segments.length === 0 ? ROOT_KEY : segments.join('/');
    tree.get(leafKey)!.directNodes.push(def);
  }

  // Second pass: sort children/direct nodes alphabetically, then
  // compute allNodes (transitive leaves) bottom-up.
  for (const cat of tree.values()) {
    cat.children.sort((a, b) =>
      tree.get(a)!.label.localeCompare(tree.get(b)!.label),
    );
    cat.directNodes.sort((a, b) => a.id.localeCompare(b.id));
  }
  // Post-order DFS from root to fill allNodes.
  const fill = (key: string): NodeDef[] => {
    const cat = tree.get(key)!;
    const out: NodeDef[] = [...cat.directNodes];
    for (const childKey of cat.children) {
      out.push(...fill(childKey));
    }
    cat.allNodes = out;
    return out;
  };
  fill(ROOT_KEY);

  return tree;
}

type ViewMode = 'icons' | 'list';

export function NodesPanel() {
  // CORE_NODES is a static module-level array, so the tree is stable
  // across renders. Memoize anyway for clarity (and to avoid re-sorting
  // on every render).
  const tree = useMemo(() => buildCategoryTree(CORE_NODES), []);
  const [selectedKey, setSelectedKey] = useState<string>(ROOT_KEY);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT_KEY]));
  const [viewMode, setViewMode] = useState<ViewMode>('icons');

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Tree-width divider — mirrors the assets-panel pattern. Width is
  // persisted in layout-store under `nodesTreeWidth`.
  const treeWidth = useLayoutStore((s) => s.nodesTreeWidth);
  const setTreeWidth = useLayoutStore((s) => s.setNodesTreeWidth);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
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
        try {
          handle.releasePointerCapture(up.pointerId);
        } catch {
          /* already released */
        }
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [setTreeWidth],
  );

  const selected = tree.get(selectedKey) ?? tree.get(ROOT_KEY)!;

  // Drag start on a tile: encode the node kind. The canvas's drop
  // handler looks up the kind in the registry and instantiates it at
  // the drop position. Single-kind payload for Phase 1 — the panel
  // doesn't support multi-selection yet.
  const onTileDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, def: NodeDef) => {
      const item: NodeKindDndItem = { kind: def.id };
      e.dataTransfer.setData(NODE_KIND_DND_TYPE, JSON.stringify(item));
      e.dataTransfer.effectAllowed = 'copy';
    },
    [],
  );

  // Right-click context menu state — { x, y } in client coords plus
  // the def the menu targets. Same dismissal pattern AssetsPanel uses:
  // capture-phase mousedown walks the click target's ancestor chain
  // for `data-menu-popup-root="1"` to keep the menu alive when the
  // click lands inside it; Esc also dismisses.
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; def: NodeDef } | null
  >(null);
  const onTileContextMenu = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, def: NodeDef) => {
      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ x: e.clientX, y: e.clientY, def });
    },
    [],
  );
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = (e: MouseEvent) => {
      let n: HTMLElement | null = e.target as HTMLElement | null;
      while (n) {
        if (n.dataset && n.dataset.menuPopupRoot === '1') return;
        n = n.parentElement;
      }
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  return (
    <div className="sedon-assets">
      <div className="sedon-assets-toolbar">
        <div className="sedon-assets-toolbar-spacer" />
        <div
          className="sedon-assets-view-toggle"
          role="tablist"
          aria-label="View mode"
        >
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
        style={{ gridTemplateColumns: `${treeWidth}px 4px 1fr` }}
      >
        <div className="sedon-assets-tree">
          <CategoryTreeRow
            cat={tree.get(ROOT_KEY)!}
            expanded={expanded.has(ROOT_KEY)}
            selected={selectedKey === ROOT_KEY}
            onToggle={() => toggle(ROOT_KEY)}
            onSelect={() => setSelectedKey(ROOT_KEY)}
          />
          {expanded.has(ROOT_KEY) &&
            renderSubtree({
              tree,
              parentKey: ROOT_KEY,
              expanded,
              selectedKey,
              toggle,
              onSelect: setSelectedKey,
            })}
        </div>
        <div
          className="sedon-assets-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize category tree"
          onPointerDown={onDividerPointerDown}
        />
        <div className="sedon-assets-contents">
          <NodesContents
            cat={selected}
            viewMode={viewMode}
            onDragStart={onTileDragStart}
            onContextMenu={onTileContextMenu}
          />
        </div>
      </div>
      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          def={contextMenu.def}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function renderSubtree(p: {
  tree: Map<string, CategoryNode>;
  parentKey: string;
  expanded: Set<string>;
  selectedKey: string;
  toggle: (key: string) => void;
  onSelect: (key: string) => void;
}): React.ReactNode[] {
  const parent = p.tree.get(p.parentKey);
  if (!parent) return [];
  return parent.children.flatMap((childKey) => {
    const cat = p.tree.get(childKey);
    if (!cat) return [];
    const isExpanded = p.expanded.has(childKey);
    return [
      <CategoryTreeRow
        key={childKey}
        cat={cat}
        expanded={isExpanded}
        selected={p.selectedKey === childKey}
        onToggle={() => p.toggle(childKey)}
        onSelect={() => p.onSelect(childKey)}
      />,
      ...(isExpanded
        ? renderSubtree({ ...p, parentKey: childKey })
        : []),
    ];
  });
}

function CategoryTreeRow(props: {
  cat: CategoryNode;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}) {
  const hasChildren = props.cat.children.length > 0;
  const cls =
    'sedon-assets-folder-row' +
    (props.selected ? ' sedon-assets-folder-row--selected' : '');
  return (
    <div
      className={cls}
      style={{ paddingLeft: 4 + props.cat.depth * 12 }}
      onClick={props.onSelect}
    >
      <span
        className="sedon-assets-folder-twisty"
        onClick={(e) => {
          e.stopPropagation();
          if (hasChildren) props.onToggle();
        }}
      >
        {hasChildren ? (props.expanded ? '▾' : '▸') : ' '}
      </span>
      <span className="sedon-assets-folder-icon">📁</span>
      <span className="sedon-assets-folder-label">{props.cat.label}</span>
    </div>
  );
}

function NodesContents(props: {
  cat: CategoryNode;
  viewMode: ViewMode;
  onDragStart: (e: React.DragEvent<HTMLDivElement>, def: NodeDef) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>, def: NodeDef) => void;
}) {
  if (props.cat.allNodes.length === 0) {
    return <div className="sedon-assets-empty">No nodes here.</div>;
  }
  const gridClass = `sedon-assets-grid sedon-assets-grid--${props.viewMode}`;
  return (
    <div className={gridClass}>
      {props.viewMode === 'list' && (
        <div className="sedon-assets-list-header">
          <span />
          <span>Kind</span>
          <span>Category</span>
        </div>
      )}
      {props.cat.allNodes.map((def) => (
        <NodeTile
          key={def.id}
          def={def}
          viewMode={props.viewMode}
          onDragStart={(e) => props.onDragStart(e, def)}
          onContextMenu={(e) => props.onContextMenu(e, def)}
        />
      ))}
    </div>
  );
}

// Pixel size of the live preview rendered inside an icon-mode tile.
// Matches roughly the natural icon area set by the assets-grid CSS so
// the texture isn't upscaled past its rendered size.
const NODE_THUMB_PX = 64;

function NodeTile(props: {
  def: NodeDef;
  viewMode: ViewMode;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const cls = `sedon-assets-tile sedon-assets-tile--${props.viewMode} sedon-assets-tile--node`;
  // Icon-mode tiles get a live preview from the node's docs sample graph
  // when available. List mode stays text-only (a 14px texture render is
  // just noise at the list row's icon column).
  //
  // Both the preview path and the glyph fallback occupy the SAME
  // NODE_THUMB_PX-square box so labels line up across the grid whether
  // or not a tile happens to have a renderable preview. For nodes
  // whose Sample-graph output isn't visually previewable (math, anim,
  // vec conversions, paths, …), a hand-picked icon from
  // `getNodeIcon(id)` reads the node's identity better than the
  // generic ◆ — and falls back to ◆ when no icon is registered.
  const customIcon = getNodeIcon(props.def.id);
  // Category tint on the icon-fallback path only. SVG strokes and
  // text icons both inherit through `currentColor`, so setting the
  // wrapper's `color` is enough. Live texture/geom previews ignore
  // this — those tiles are already visually distinct via their
  // rendered content.
  const placeholder = (
    <div
      style={{
        width: NODE_THUMB_PX,
        height: NODE_THUMB_PX,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: categoryColorFor(props.def.id),
      }}
    >
      {customIcon ?? <span className="sedon-assets-tile-icon">◆</span>}
    </div>
  );
  // When the registry has an author-provided icon, prefer it over the
  // live preview entirely. The icon is the explicit "this is what the
  // node DOES" signal — overrides the sample-graph thumbnail when both
  // exist (e.g. math/vec3-from-floats whose preview is a generic cube).
  const iconWins = hasNodeIcon(props.def.id);
  const icon =
    props.viewMode === 'icons' ? (
      iconWins ? (
        placeholder
      ) : (
        <NodeThumbnail
          def={props.def}
          size={NODE_THUMB_PX}
          fallback={placeholder}
        />
      )
    ) : (
      <span className="sedon-assets-tile-icon">◆</span>
    );

  // Split the id at its last '/': the suffix (node name) becomes the
  // top label, the prefix (category path) becomes the smaller subline.
  // Most ids have exactly one slash; multi-slash ids (none today, but
  // permitted by the schema) collapse all preceding segments into the
  // subline.
  const lastSlash = props.def.id.lastIndexOf('/');
  const name = lastSlash < 0 ? props.def.id : props.def.id.slice(lastSlash + 1);
  const prefix = lastSlash < 0 ? '' : props.def.id.slice(0, lastSlash);
  // Output-type stripe across the top of the tile, mirroring the
  // canvas node's output bar so users learn one palette. Solid colour
  // for a single output, hard-stop gradient for multi-output nodes —
  // each output segment is the same width as it would be on the
  // canvas, so the visual maps 1:1.
  const stripeBg = outputBarBackground(props.def);
  return (
    <div
      className={cls}
      draggable
      onDragStart={props.onDragStart}
      onContextMenu={props.onContextMenu}
      title={`${props.def.id}\n${props.def.category}\n\nDrag onto the canvas to add.`}
    >
      <div className="sedon-tile-output-bar" style={{ background: stripeBg }} />
      {icon}
      <span className="sedon-assets-tile-label">{name}</span>
      <span className="sedon-assets-tile-type">{prefix}</span>
    </div>
  );
}

function NodeContextMenu(props: {
  x: number;
  y: number;
  def: NodeDef;
  onClose: () => void;
}) {
  const docsUrl = docsUrlFor(props.def.id, 'site-root');
  return (
    <div
      className="sedon-assets-context-menu"
      style={{ left: props.x, top: props.y }}
      // Ancestor walk in NodesPanel's onMouseDown handler looks for
      // this attribute to keep the menu alive when clicked.
      data-menu-popup-root="1"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="sedon-assets-context-menu-title">{props.def.id}</div>
      <button
        type="button"
        className="sedon-assets-context-menu-item"
        onClick={(e) => {
          e.stopPropagation();
          window.open(docsUrl, '_blank', 'noreferrer');
          props.onClose();
        }}
      >
        Docs
      </button>
    </div>
  );
}
