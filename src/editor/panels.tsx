import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { DockviewPanelApi, IDockviewPanelProps } from 'dockview';
import { useEffect, useRef } from 'react';
import { wouldCreateCycle } from '../core/folder.js';
import { AddNodeMenu } from './add-node-menu.js';
import { AssetsPanel, ASSET_DND_TYPE, type AssetDndItem } from './assets-panel.js';
import { useLayoutStore } from './layout-store.js';
import { NodeCanvas } from './node-canvas.js';
import {
  NodesPanel,
  NODE_KIND_DND_TYPE,
  type NodeKindDndItem,
} from './nodes-panel.js';
import { Preview } from './preview.js';
import { useEditorStore } from './store.js';

// Resolve a graph id ('main' or a subgraph id) into its human label.
// 'main' becomes 'Main'; subgraphs use their SubgraphDef.label (which
// is renameable, so the tab updates live when the user renames a
// subgraph). Falls back to the raw id if the subgraph was deleted —
// usually transient (e.g. mid-undo) and clearer than a blank tab.
function useGraphLabel(graphId: string): string {
  return useEditorStore((s) => {
    if (graphId === 'main') return 'Main';
    const sg = s.subgraphs.find((g) => g.id === graphId);
    return sg?.label ?? graphId;
  });
}

// Push `title` into the DockView tab whenever it changes. Used by
// Canvas + Preview panels to mirror "which graph am I showing" into
// the tab strip — same convention VSCode uses for file tabs.
function useDockviewPanelTitle(api: DockviewPanelApi, title: string): void {
  useEffect(() => {
    api.setTitle(title);
  }, [api, title]);
}

// DockView panel components. Each panel kind ('node-canvas', 'preview',
// 'assets', later 'inspector' / …) is registered once via the components
// map passed to <DockviewReact />. The app's single ReactFlowProvider
// lives above this in App.tsx; per-panel RF providers (one per canvas)
// land in Phase 2b when canvases pin to different graphs.

// DockView panel wrapper for a canvas. We mount a fresh
// ReactFlowProvider per panel so each canvas gets its own RF store —
// without this, two canvases would share viewport + nodes through the
// app-level provider, and panning one would scroll both.
//
// The inner component lives below the provider so it can use
// useReactFlow(), which only resolves inside its provider's subtree.
export function NodeCanvasPanel(props: IDockviewPanelProps) {
  // Resolve effective graph for this canvas (pinned id or whatever the
  // user is currently editing) and mirror its label into the tab.
  // Same fallback chain as NodeCanvas itself — kept here so the title
  // updates even before the inner component mounts.
  const pinnedGraphId = useLayoutStore((s) => s.canvasGraphIds[props.api.id]);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const effectiveGraphId = pinnedGraphId ?? currentEditingId;
  const label = useGraphLabel(effectiveGraphId);
  useDockviewPanelTitle(props.api, label);
  return (
    <ReactFlowProvider>
      <NodeCanvasPanelInner panelId={props.api.id} />
    </ReactFlowProvider>
  );
}

function NodeCanvasPanelInner({ panelId }: { panelId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  const addNode = useEditorStore((s) => s.addNode);

  // Accept drops from the Assets view: an `application/sedon-asset`
  // payload is a JSON array of `AssetDndItem`s. Each subgraph item
  // becomes a wrapper instance at the drop point; folder and main
  // items are ignored here (they only mean something to the Asset view
  // or the Preview pane respectively). Multiple wrappers are staggered
  // by a small offset so they don't overlap on the canvas.
  //
  // Cycle prevention: a wrapper of subgraph X can't be dropped into
  // X's own inner graph (or anywhere that's already reachable from X
  // via wrapper chains). `wouldCreateCycle` walks the candidate
  // forward and refuses any drop that would close the loop. Without
  // this, evaluator hits MAX_SUBGRAPH_DEPTH at run time — better to
  // never let the user author the cycle in the first place. Cycle
  // failures in a multi-drop skip just the offending item; the rest
  // still drop.
  // Canvas accepts two DnD payloads:
  //   • ASSET_DND_TYPE     — from the Assets panel; instantiates a
  //                          subgraph wrapper at the drop point.
  //   • NODE_KIND_DND_TYPE — from the Nodes panel; instantiates a core
  //                          node of the given kind at the drop point.
  // Each branch reads its own MIME from the DataTransfer; the dragenter
  // / dragover handlers accept either to show the user a copy cursor.
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    const types = e.dataTransfer.types;
    if (
      types.includes(ASSET_DND_TYPE) ||
      types.includes(NODE_KIND_DND_TYPE)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const nodeRaw = e.dataTransfer.getData(NODE_KIND_DND_TYPE);
    const assetRaw = e.dataTransfer.getData(ASSET_DND_TYPE);
    if (!nodeRaw && !assetRaw) return;
    e.preventDefault();
    const basePosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });

    // Node-kind drop: single node from the Nodes panel.
    if (nodeRaw) {
      let item: NodeKindDndItem;
      try {
        item = JSON.parse(nodeRaw) as NodeKindDndItem;
      } catch {
        return;
      }
      const id = crypto.randomUUID();
      rf.addNodes({
        id,
        type: 'sedon',
        position: basePosition,
        data: { kind: item.kind },
      });
      addNode({ id, kind: item.kind, position: basePosition });
      return;
    }

    // Asset drop: 1+ subgraph wrappers, possibly mixed with folder/main
    // items the canvas ignores. Multi-drop stagger keeps overlapping
    // wrappers visible.
    let items: AssetDndItem[];
    try {
      items = JSON.parse(assetRaw) as AssetDndItem[];
    } catch {
      return;
    }
    const state = useEditorStore.getState();
    const offsetStep = 24;
    let placed = 0;
    const skipped: string[] = [];
    for (const item of items) {
      if (item.kind !== 'subgraph') continue;
      if (wouldCreateCycle(state.currentEditingId, item.id, state.subgraphs)) {
        const sg = state.subgraphs.find((s) => s.id === item.id);
        skipped.push(sg?.label ?? item.id);
        continue;
      }
      const sg = state.subgraphs.find((s) => s.id === item.id);
      if (!sg) continue;
      const id = crypto.randomUUID();
      const position = {
        x: basePosition.x + placed * offsetStep,
        y: basePosition.y + placed * offsetStep,
      };
      rf.addNodes({
        id,
        type: 'sedon',
        position,
        data: { kind: `subgraph/${sg.id}` },
      });
      addNode({ id, kind: `subgraph/${sg.id}`, position });
      placed++;
    }
    if (skipped.length > 0) {
      // eslint-disable-next-line no-alert
      window.alert(
        `Skipped ${skipped.length} item${skipped.length === 1 ? '' : 's'} that would create subgraph cycles: ${skipped.join(', ')}`,
      );
    }
  };

  return (
    <div
      ref={containerRef}
      className="sedon-panel sedon-panel--canvas"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <NodeCanvas panelId={panelId} />
      <AddNodeMenu canvasRef={containerRef} />
    </div>
  );
}

export function PreviewPanel(props: IDockviewPanelProps) {
  // Asset → Preview: dropping a subgraph here pins this Preview pane to
  // that graph (same effect as picking it from the "View:" dropdown).
  // The pin lives in the layout store keyed by DockView panel id, so
  // each Preview maintains an independent target.
  const panelId = props.api.id;
  // Mirror the effective graph label into the tab title, same chain
  // Preview itself uses for picking which graph to render.
  const pinnedGraphId = useLayoutStore((s) => s.pinnedGraphIds[panelId]);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const effectiveGraphId = pinnedGraphId ?? currentEditingId;
  const label = useGraphLabel(effectiveGraphId);
  useDockviewPanelTitle(props.api, label);
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'link';
    }
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const raw = e.dataTransfer.getData(ASSET_DND_TYPE);
    if (!raw) return;
    e.preventDefault();
    let items: AssetDndItem[];
    try {
      items = JSON.parse(raw) as AssetDndItem[];
    } catch {
      return;
    }
    // Preview only pins to one graph, so a multi-drop picks the first
    // pinnable item (subgraph or main). Folder items are ignored.
    const pinnable = items.find((it) => it.kind === 'subgraph' || it.kind === 'main');
    if (!pinnable) return;
    useLayoutStore.getState().setPanelPinnedGraph(panelId, pinnable.id);
  };
  return (
    <div
      className="sedon-panel sedon-panel--preview"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Preview panelId={panelId} />
    </div>
  );
}

export function AssetsPanelWrapper(_props: IDockviewPanelProps) {
  return (
    <div className="sedon-panel sedon-panel--assets">
      <AssetsPanel />
    </div>
  );
}

export function NodesPanelWrapper(_props: IDockviewPanelProps) {
  return (
    <div className="sedon-panel sedon-panel--assets">
      <NodesPanel />
    </div>
  );
}

// Registry passed to <DockviewReact components={...}>. Each key is the
// `component` string referenced when calling `api.addPanel({...})`.
export const PANEL_COMPONENTS = {
  'node-canvas': NodeCanvasPanel,
  preview: PreviewPanel,
  assets: AssetsPanelWrapper,
  nodes: NodesPanelWrapper,
};
