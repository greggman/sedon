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

import { flushUnusedPools } from '../render/scene.js';

type RenderCallback = () => void;

const callbacks = new Set<RenderCallback>();
let pendingRaf: number | null = null;

// ---- Animation clock ----------------------------------------------------
// Render-on-demand is the default (idle previews burn no GPU). Animation
// is OPT-IN via the preview's play/pause: while playing we keep a
// continuous rAF alive, advance an elapsed-seconds clock, and re-request
// every frame. `animationTime()` is fed into SceneRenderer.render() so
// grass wind (and any future time-driven effect) animates. Paused ⇒ the
// clock holds its last value, so previews freeze rather than snapping to
// t=0.
let playing = false;
let elapsed = 0; // seconds
let lastFrameMs: number | null = null;
const animListeners = new Set<(playing: boolean) => void>();

/** Current animation time in seconds. Frozen while paused. */
export function animationTime(): number {
  return elapsed;
}

/** Whether the animation loop is currently running. */
export function isAnimating(): boolean {
  return playing;
}

/** Subscribe to play/pause changes (for the toolbar toggle's label). */
export function subscribeAnimating(cb: (playing: boolean) => void): () => void {
  animListeners.add(cb);
  return () => { animListeners.delete(cb); };
}

export function setAnimating(on: boolean): void {
  if (playing === on) return;
  playing = on;
  lastFrameMs = null; // reset dt accumulation so we don't jump on resume
  for (const cb of animListeners) cb(on);
  if (on) requestRender(); // kick the self-sustaining loop
}

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
  pendingRaf = requestAnimationFrame((nowMs) => {
    pendingRaf = null;
    // Advance the animation clock by the real frame delta while playing.
    if (playing) {
      if (lastFrameMs !== null) elapsed += (nowMs - lastFrameMs) / 1000;
      lastFrameMs = nowMs;
    }
    // Snapshot so subscribers are free to add/remove during the tick.
    for (const cb of [...callbacks]) cb();
    // After every frame's renders finish, reclaim any SceneRenderer
    // pool entries (instance buffers, material bind groups, size-
    // bound intermediates) whose refcount has fallen to zero — e.g.
    // because a mesh-segments slider scrub orphaned the previous
    // tick's positionBuffer-keyed entry. Eviction is deferred until
    // after the frame's renders so a same-frame remount (React
    // useEffect cleanup → new mount) reclaims the entry instead of
    // re-allocating.
    flushUnusedPools();
    // Self-sustaining loop while playing: keep frames coming so the
    // clock advances and time-driven effects animate. Stops the moment
    // the user pauses (setAnimating(false)).
    if (playing) requestRender();
  });
}
