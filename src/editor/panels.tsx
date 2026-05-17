import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { IDockviewPanelProps } from 'dockview';
import { useRef } from 'react';
import { wouldCreateCycle } from '../core/folder.js';
import { AddNodeMenu } from './add-node-menu.js';
import { AssetsPanel, ASSET_DND_TYPE, type AssetDndItem } from './assets-panel.js';
import { useLayoutStore } from './layout-store.js';
import { NodeCanvas } from './node-canvas.js';
import { Preview } from './preview.js';
import { useEditorStore } from './store.js';

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
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(ASSET_DND_TYPE)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
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
    const state = useEditorStore.getState();
    const basePosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
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

// Registry passed to <DockviewReact components={...}>. Each key is the
// `component` string referenced when calling `api.addPanel({...})`.
export const PANEL_COMPONENTS = {
  'node-canvas': NodeCanvasPanel,
  preview: PreviewPanel,
  assets: AssetsPanelWrapper,
};
