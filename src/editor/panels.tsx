import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import type { IDockviewPanelProps } from 'dockview';
import { useRef } from 'react';
import { wouldCreateCycle } from '../core/folder.js';
import { AddNodeMenu } from './add-node-menu.js';
import { AssetsPanel, ASSET_DND_TYPE, type AssetDndPayload } from './assets-panel.js';
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
  // payload with `kind: 'subgraph'` instantiates a wrapper of that
  // subgraph at the drop point. Folder-kind drops are ignored here —
  // they only mean something inside the Asset view.
  //
  // Cycle prevention: a wrapper of subgraph X can't be dropped into
  // X's own inner graph (or anywhere that's already reachable from X
  // via wrapper chains). `wouldCreateCycle` walks the candidate
  // forward and refuses any drop that would close the loop. Without
  // this, evaluator hits MAX_SUBGRAPH_DEPTH at run time — better to
  // never let the user author the cycle in the first place.
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
    let payload: AssetDndPayload;
    try {
      payload = JSON.parse(raw) as AssetDndPayload;
    } catch {
      return;
    }
    if (payload.kind !== 'subgraph') return;
    const state = useEditorStore.getState();
    if (wouldCreateCycle(state.currentEditingId, payload.id, state.subgraphs)) {
      // eslint-disable-next-line no-alert
      window.alert(
        `Can't drop "${payload.id}" here — it would create a subgraph cycle.`,
      );
      return;
    }
    const sg = state.subgraphs.find((s) => s.id === payload.id);
    if (!sg) return;
    const id = crypto.randomUUID();
    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    rf.addNodes({
      id,
      type: 'sedon',
      position,
      data: { kind: `subgraph/${sg.id}` },
    });
    addNode({ id, kind: `subgraph/${sg.id}`, position });
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
    let payload: AssetDndPayload;
    try {
      payload = JSON.parse(raw) as AssetDndPayload;
    } catch {
      return;
    }
    // Both subgraph and main are valid pin targets — main pins this
    // Preview to the project's root graph (same effect as picking
    // "Main" from the dropdown). Folders aren't pinnable.
    if (payload.kind !== 'subgraph' && payload.kind !== 'main') return;
    useLayoutStore.getState().setPanelPinnedGraph(panelId, payload.id);
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
