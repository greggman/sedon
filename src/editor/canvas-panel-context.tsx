import { createContext, useContext } from 'react';
import type { Graph } from '../core/graph.js';
import type { NodeOutputs } from '../core/node-def.js';

// React context carrying which canvas a CustomNode is rendered inside:
//
//   • panelId — DockView panel id; used by the Edit button to pin the
//     right canvas instead of globally swapping currentEditingId.
//   • graph — the per-canvas graph this panel is displaying. Children
//     (CustomNode in particular) MUST look up their node here rather
//     than `state.graph`, which is the actively-edited graph and may
//     belong to a different canvas after per-canvas pinning. Without
//     this, a CustomNode in canvas A would query state.graph (canvas
//     B's graph), fail to find itself, and render with stale defaults
//     (missing variadic handles, missing inputValues, etc.) — the
//     classic "scene_0 handle not found" / error 008 trigger.
//   • allOutputs — per-node eval outputs for THIS canvas's graph. Each
//     canvas evaluates its own pinned graph (see NodeCanvas) and
//     publishes the result here so in-node previews (ScenePreview,
//     MaterialPreview, TexturePreview) get the right data even when
//     no Preview pane is showing this canvas's graph. Without this,
//     a canvas pinned to a subgraph not currently active in any
//     Preview would render only "—" placeholders for its nodes
//     because state.evalResult is fed by the active Preview.
//
// `null` means the consumer isn't inside a canvas (test harness, etc.).
export interface CanvasPanelInfo {
  panelId: string;
  graph: Graph;
  allOutputs: Map<string, NodeOutputs> | null;
}

export const CanvasPanelContext = createContext<CanvasPanelInfo | null>(null);

export function useCanvasPanelId(): string | null {
  return useContext(CanvasPanelContext)?.panelId ?? null;
}

export function useCanvasGraph(): Graph | null {
  return useContext(CanvasPanelContext)?.graph ?? null;
}

export function useCanvasAllOutputs(): Map<string, NodeOutputs> | null {
  return useContext(CanvasPanelContext)?.allOutputs ?? null;
}
