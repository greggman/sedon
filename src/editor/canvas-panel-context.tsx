import { createContext, useContext } from 'react';

// React context carrying ONLY which canvas a CustomNode is rendered
// inside (the DockView panel id). This value is stable for a panel's
// lifetime, so it never triggers re-renders.
//
// Per-node data (the node's GraphNode + its eval output) is delivered
// separately through `canvas-data.ts`'s per-node external store —
// NOT through this context. Earlier the context also carried the whole
// graph + allOutputs map; both change identity on every edit/eval, so
// every CustomNode re-rendered each tick (~105/tick on Forest). The
// panelId here is the key a CustomNode uses to subscribe to its own
// slice of that store.
//
// `null` means the consumer isn't inside a canvas (test harness, etc.).
export interface CanvasPanelInfo {
  panelId: string;
}

export const CanvasPanelContext = createContext<CanvasPanelInfo | null>(null);

export function useCanvasPanelId(): string | null {
  return useContext(CanvasPanelContext)?.panelId ?? null;
}
