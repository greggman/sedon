import type { ReactFlowInstance } from '@xyflow/react';
import { getDockviewApi } from './dockview-handle.js';

// Module-level registry mapping DockView canvas-panel ids to their
// ReactFlowInstance. Each canvas registers on mount and clears on
// unmount; toolbar items and command-palette actions that need RF
// (auto-layout / measurement) reach for the active canvas here
// instead of calling `useReactFlow()` (which is no longer available
// at the toolbar level once each canvas has its own provider).
//
// "Active canvas" resolves via the DockView API:
//   1. If the currently-active DockView panel is a canvas, use it.
//   2. Otherwise fall back to whichever canvas was registered most
//      recently — better than failing, since the toolbar caller almost
//      certainly meant "the canvas the user was last interacting with".

const registry = new Map<string, ReactFlowInstance>();

export function registerCanvasRf(panelId: string, rf: ReactFlowInstance): void {
  registry.set(panelId, rf);
}

export function unregisterCanvasRf(panelId: string): void {
  registry.delete(panelId);
}

export function getCanvasRf(panelId: string): ReactFlowInstance | null {
  return registry.get(panelId) ?? null;
}

export function getActiveCanvasRf(): ReactFlowInstance | null {
  const api = getDockviewApi();
  const active = api?.activePanel;
  if (active) {
    const direct = registry.get(active.id);
    if (direct) return direct;
  }
  // Fall back to any registered canvas. Iteration order on Map is
  // insertion order; the last registered (most recent mount) lands last,
  // so we peek the tail to prefer recency.
  let last: ReactFlowInstance | null = null;
  for (const rf of registry.values()) last = rf;
  return last;
}
