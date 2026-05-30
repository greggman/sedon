import { createContext, useContext } from 'react';
import type { DocsCallerLocation } from '../docs/doc-paths.js';

// React context carrying which canvas a CustomNode is rendered inside
// (the DockView panel id) AND where on the deployed site that canvas
// lives (`docsLocation`, used to compute relative URLs into the docs).
// Both values are stable for a panel's lifetime, so this never triggers
// re-renders.
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
  /**
   * Where on the deployed site this canvas is being rendered. Editor
   * canvases at the site root pass `'site-root'`; the per-node docs
   * sample-graph preview passes `{ kind: 'docs-node', id }` so the
   * [?] icons inside it produce URLs relative to the doc page hosting
   * the preview.
   */
  docsLocation: DocsCallerLocation;
}

export const CanvasPanelContext = createContext<CanvasPanelInfo | null>(null);

export function useCanvasPanelId(): string | null {
  return useContext(CanvasPanelContext)?.panelId ?? null;
}

export function useDocsLocation(): DocsCallerLocation {
  return useContext(CanvasPanelContext)?.docsLocation ?? 'site-root';
}
