// Render-on-demand bus shared across PreviewTile instances.
//
// The preview pane used to drive every tile's canvas from a continuous
// requestAnimationFrame loop, which burned GPU even when nothing changed.
// Now each tile subscribes a render callback here and the bus only fires
// when something explicitly requests a redraw — camera mutation, resize,
// scene re-eval, WASD motion, etc.
//
// Coalescing: multiple `requestRender()` calls inside the same frame
// schedule exactly one rAF. The callbacks all fire in that single tick,
// so N tiles draw one frame each per request rather than N rAFs each.

type RenderCallback = () => void;

const callbacks = new Set<RenderCallback>();
let pendingRaf: number | null = null;

/**
 * Register a render callback. Returns an unsubscribe function — call it
 * from your effect's cleanup (or whenever the closure becomes stale) so
 * `requestRender()` stops firing into a torn-down tile.
 */
export function subscribeRender(cb: RenderCallback): () => void {
  callbacks.add(cb);
  return () => {
    callbacks.delete(cb);
  };
}

/**
 * Schedule a redraw on the next animation frame. Idempotent — multiple
 * calls within the same frame coalesce into a single rAF that fires every
 * registered callback once.
 */
export function requestRender(): void {
  if (pendingRaf !== null) return;
  pendingRaf = requestAnimationFrame(() => {
    pendingRaf = null;
    // Snapshot so subscribers are free to add/remove during the tick.
    for (const cb of [...callbacks]) cb();
  });
}
