import type { DockviewApi } from 'dockview';

// Module-level singleton holding the DockView API once App's onReady
// fires. The palette and other "imperative" callers (keyboard shortcuts,
// menu items) reach for the API here instead of needing it routed
// through React props/context — there's exactly one DockView root in
// the app, and treating it like a singleton matches DockView's own
// world model.
//
// Set on mount, cleared on unmount, queried wherever needed. If a caller
// fires before App has mounted, `null` is returned and the caller no-ops.

let api: DockviewApi | null = null;

export function setDockviewApi(next: DockviewApi | null): void {
  api = next;
}

export function getDockviewApi(): DockviewApi | null {
  return api;
}
