import type { CanvasContextMenuItem } from './canvas-context-menu.js';
import {
  copySelection,
  cutSelection,
  idsForRightClickedNode,
  pasteFromClipboard,
} from './clipboard-ops.js';
import { createSubgraphAt, extractSelectionToSubgraph } from './commands.js';
import { requestNodeRename } from './rename-bus.js';

// Single source of truth for "what does the canvas right-click menu
// offer?" Both the pane right-click (node-canvas's onPaneContextMenu)
// and the node right-click (custom-node's onContextMenu) call this
// with their respective context. Adding an item here lights up both
// surfaces consistently — preventing the menu/palette drift the
// action registry was built to fix.
//
// What's always available (in both menus):
//   • Add Node…     opens the search picker at the click point;
//                   picked node lands at the click flow position
//   • Add Subgraph  creates a new subgraph + wrapper at the click
//                   flow position, starts inline rename
//   • Cut / Copy    operate on the canvas selection; right-clicking
//                   a node not in the selection promotes it to be
//                   the selection first (Finder-style)
//   • Paste         paste OS-clipboard at the click flow position
//
// Node-only items (omitted when right-clicking the empty pane):
//   • Rename
//   • Edit          for subgraph wrappers (drills in)
//   • Edit iter…    for for-each-point (drills into its bridge)

export interface CanvasMenuContext {
  /** Flow-coordinate position of the right-click — where Add Node
   *  drops, where Paste lands. */
  flowX: number;
  flowY: number;
  /** Callback that opens the AddNodePicker. Lives in the host
   *  component (NodeCanvas) because the picker is part of its
   *  render tree. */
  openAddNodePicker: () => void;
  /** Present when right-clicking ON a node (vs the empty pane).
   *  When omitted, the menu omits Rename / Edit / Edit iteration. */
  node?: CanvasMenuNode;
}

export interface CanvasMenuNode {
  id: string;
  isSubgraphWrapper: boolean;
  isForEachPoint: boolean;
  /** Truthy on subgraph wrappers — enables "Edit" (drill-in). */
  subgraphId?: string;
  /** Truthy on for-each-point nodes with a bridge — enables
   *  "Edit iteration" (drill into the bridge graph). */
  forEachBridgeId?: string;
  /** Drill-in callback for subgraph wrappers. */
  onEdit?: () => void;
  /** Drill-in callback for for-each-point bridges. */
  onEditIteration?: () => void;
  /** Set on nodes whose def carries a `doc` block — enables
   *  "Open Docs". Same URL the inline `?` header link uses. */
  docsUrl?: string;
}

// When invoked from a node context menu, Add Node / Add Subgraph /
// Paste land slightly offset from the click point so the new node
// doesn't sit directly on top of the one the user right-clicked.
// Pane-menu invocations land exactly at the click (the user clicked
// empty space — no overlap risk).
const NODE_DROP_OFFSET = 60;

export function buildCanvasMenuItems(ctx: CanvasMenuContext): CanvasContextMenuItem[] {
  const items: CanvasContextMenuItem[] = [];

  // Where new / pasted nodes land. From the empty pane this is the
  // click point itself; from a node menu it's offset so the new
  // arrival doesn't overlap the one the user right-clicked.
  const dropX = ctx.node ? ctx.flowX + NODE_DROP_OFFSET : ctx.flowX;
  const dropY = ctx.node ? ctx.flowY + NODE_DROP_OFFSET : ctx.flowY;

  // ── Always-on items ──────────────────────────────────────
  items.push({
    label: 'Add Node…',
    run: ctx.openAddNodePicker,
  });
  items.push({
    label: 'Add Subgraph',
    run: () => createSubgraphAt({ x: dropX, y: dropY }),
  });
  items.push({ kind: 'separator' });
  items.push({
    label: 'Cut',
    hint: '⌘X',
    run: () => {
      // When right-clicked on a node not in the canvas selection,
      // cut just that node. When on a selected node (or any member
      // of a multi-selection), cut the whole selection. Pane-menu
      // invocation falls back to the current canvas selection.
      const ids = ctx.node ? idsForRightClickedNode(ctx.node.id) : undefined;
      void cutSelection(ids);
    },
  });
  items.push({
    label: 'Copy',
    hint: '⌘C',
    run: () => {
      const ids = ctx.node ? idsForRightClickedNode(ctx.node.id) : undefined;
      void copySelection(ids);
    },
  });
  items.push({
    label: 'Paste',
    hint: '⌘V',
    run: () => {
      void pasteFromClipboard({ pasteAt: { x: dropX, y: dropY } });
    },
  });
  items.push({ kind: 'separator' });
  items.push({
    label: 'Extract to Subgraph',
    run: () => {
      // Three call sites:
      //   • Pane / multi-select menu (no `ctx.node`) → operate on
      //     the current canvas selection.
      //   • Single-node menu, node is part of a selection → operate
      //     on the whole selection (idsForRightClickedNode returns
      //     it).
      //   • Single-node menu, node NOT in selection → extract just
      //     that node.
      const ids = ctx.node ? idsForRightClickedNode(ctx.node.id) : undefined;
      extractSelectionToSubgraph(ids);
    },
  });

  // ── Node-only items ──────────────────────────────────────
  if (ctx.node) {
    items.push({ kind: 'separator' });
    items.push({
      label: 'Rename',
      run: () => requestNodeRename(ctx.node!.id),
    });
    if (ctx.node.isSubgraphWrapper && ctx.node.subgraphId && ctx.node.onEdit) {
      items.push({
        label: 'Edit',
        hint: 'double-click preview',
        run: ctx.node.onEdit,
      });
    }
    if (ctx.node.isForEachPoint && ctx.node.forEachBridgeId && ctx.node.onEditIteration) {
      items.push({
        label: 'Edit iteration',
        run: ctx.node.onEditIteration,
      });
    }
    if (ctx.node.docsUrl) {
      const url = ctx.node.docsUrl;
      items.push({
        label: 'Open Docs',
        run: () => {
          window.open(url, '_blank', 'noreferrer');
        },
      });
    }
  }

  return items;
}
