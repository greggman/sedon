import { getDockviewApi } from './dockview-handle.js';

// Module-level registry mapping DockView preview-panel ids to a
// callback that runs the panel's "frame selected (or all)" logic.
// Mirrors `rf-registry.ts` for canvas panels — toolbar items and
// command-palette actions need a way to reach into a specific preview
// without prop-drilling.
//
// "Active preview" resolves the same way as rf-registry does for
// canvases: prefer the currently-active DockView panel, then any
// preview the user interacted with recently, then any registered
// preview.

interface PreviewHandlers {
  frameSelected: () => void;
}

const registry = new Map<string, PreviewHandlers>();
// Most-recently registered or activated panel — used as the fallback
// when DockView's active panel isn't a preview (e.g. menu bar is
// open, command palette dispatching) and no last-active record
// exists. Updated by registerPreview() and noteActivePreview().
let lastTouched: string | null = null;

export function registerPreview(
  panelId: string,
  handlers: PreviewHandlers,
): void {
  registry.set(panelId, handlers);
  lastTouched = panelId;
}

export function unregisterPreview(panelId: string): void {
  registry.delete(panelId);
  if (lastTouched === panelId) {
    lastTouched = null;
    // Walk back to the most-recently-mounted remaining preview, if
    // any. Map iteration is insertion-order; the tail is freshest.
    for (const id of registry.keys()) lastTouched = id;
  }
}

/**
 * Bump the "active preview" pointer when DockView reports a preview
 * panel became active. Lets `getActivePreview()` return the right
 * one when a non-preview panel is focused (menu bar etc.) but the
 * user's last preview interaction is unambiguous.
 */
export function noteActivePreview(panelId: string): void {
  if (registry.has(panelId)) lastTouched = panelId;
}

export function getActivePreview(): PreviewHandlers | null {
  const api = getDockviewApi();
  const active = api?.activePanel;
  if (active) {
    const direct = registry.get(active.id);
    if (direct) return direct;
  }
  if (lastTouched) {
    const last = registry.get(lastTouched);
    if (last) return last;
  }
  // Final fallback: any registered preview.
  let any: PreviewHandlers | null = null;
  for (const handlers of registry.values()) any = handlers;
  return any;
}

/**
 * Convenience predicate used by the menu command to choose between
 * "frame selected in canvas" vs "frame selected in preview" based on
 * which panel type is currently focused. Returns true when DockView's
 * active panel is a preview; false otherwise (including when no
 * dockview panel is active).
 */
export function activePanelIsPreview(): boolean {
  const api = getDockviewApi();
  const active = api?.activePanel;
  if (!active) return false;
  return active.view.contentComponent === 'preview';
}
