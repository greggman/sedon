import type { ReactFlowInstance } from '@xyflow/react';
import { getDockviewApi } from './dockview-handle.js';
import { useLayoutStore } from './layout-store.js';

// Module-level registry mapping DockView canvas-panel ids to their
// ReactFlowInstance. Each canvas registers on mount and clears on
// unmount; toolbar items and command-palette actions that need RF
// (auto-layout / measurement) reach for the active canvas here
// instead of calling `useReactFlow()` (which is no longer available
// at the toolbar level once each canvas has its own provider).
//
// "Active canvas" resolves in order:
//   1. If the currently-active DockView panel is a canvas, use it.
//   2. Otherwise prefer `lastActiveCanvasPanelId` from the layout
//      store — that's the LAST canvas the user actually interacted
//      with (updated by DockView's onDidActivePanelChange in app.tsx).
//      Critical when the dockview-active panel isn't a canvas (asset
//      panel focused, menubar open, Cmd-Shift-P palette dispatching):
//      a menubar "Add: cube" or palette "Add: …" should drop the node
//      into the canvas the user was looking at, not whichever
//      happened to mount last.
//   3. Final fallback to any registered canvas (mount order). Better
//      than failing, but only reached when the user has never made a
//      canvas active in this session — typically right after load.

interface CanvasEntry {
  rf: ReactFlowInstance;
  el: HTMLElement | null;
}

const registry = new Map<string, CanvasEntry>();

export function registerCanvasRf(
  panelId: string,
  rf: ReactFlowInstance,
  el: HTMLElement | null = null,
): void {
  registry.set(panelId, { rf, el });
}

export function unregisterCanvasRf(panelId: string): void {
  registry.delete(panelId);
}

export function getCanvasRf(panelId: string): ReactFlowInstance | null {
  return registry.get(panelId)?.rf ?? null;
}

function getActiveEntry(): CanvasEntry | null {
  const api = getDockviewApi();
  const active = api?.activePanel;
  if (active) {
    const direct = registry.get(active.id);
    if (direct) return direct;
  }
  const lastActiveId = useLayoutStore.getState().lastActiveCanvasPanelId;
  if (lastActiveId) {
    const lastActive = registry.get(lastActiveId);
    if (lastActive) return lastActive;
  }
  // Final fallback: any registered canvas. Iteration order on Map is
  // insertion order; the last registered (most recent mount) lands last,
  // so we peek the tail to prefer recency.
  let last: CanvasEntry | null = null;
  for (const entry of registry.values()) last = entry;
  return last;
}

export function getActiveCanvasRf(): ReactFlowInstance | null {
  return getActiveEntry()?.rf ?? null;
}

export function getActiveCanvasEl(): HTMLElement | null {
  return getActiveEntry()?.el ?? null;
}
