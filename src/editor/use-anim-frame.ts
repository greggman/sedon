import { useEffect, useMemo, useState } from 'react';
import { currentAnimFrame, subscribeAnimFrame } from './render-bus.js';
import { useEditorStore } from './store.js';

// Hook for components that need to re-fire their eval effect each
// animation frame while the preview's Play/Pause is in Play. Returns
// a counter that increments on each rAF tick during playback and
// stays frozen while paused.
//
// Mirrors the `useImageLoadGeneration` pattern: stick the returned
// value in your effect's dep list, and the effect re-runs once per
// frame when playing. The eval cache short-circuits any node whose
// fingerprint is unchanged, so only `anim/*` outputs and their
// downstream consumers actually re-evaluate per frame.
//
// Components NOT in scope (asset thumbnails, docs samples) can skip
// the hook — they'll evaluate against a frozen animationTime each
// time their own deps fire.
//
// Project-wide animation-presence gate: when NO node in the project
// (main graph or any subgraph) has an `anim/*` kind, even a cache-
// confirming re-walk costs O(N) per frame — perceivable on big scenes
// with hundreds of nodes (e.g. scene=city). In that case we don't
// subscribe to the per-frame bus and return a stable counter, so the
// consumer's useEffect doesn't refire on every animation tick. As
// soon as a user adds an anim/* node, the project predicate flips and
// the subscription re-arms.
export function useAnimFrameGeneration(): number {
  const projectHasAnim = useProjectHasAnimNodes();
  const [gen, setGen] = useState<number>(() => currentAnimFrame());
  useEffect(() => {
    if (!projectHasAnim) return;
    return subscribeAnimFrame((n) => setGen(n));
  }, [projectHasAnim]);
  return gen;
}

// Returns true when at least one `anim/*` node lives anywhere in the
// project — the main graph or any subgraph. Cheap O(N) check memoised
// against the slice of state it reads, so the predicate flips only
// when nodes are added / removed / their kinds change.
export function useProjectHasAnimNodes(): boolean {
  const mainGraph = useEditorStore((s) => s.mainGraph);
  const subgraphs = useEditorStore((s) => s.subgraphs);
  return useMemo(() => {
    for (const n of mainGraph.nodes) {
      if (n.kind.startsWith('anim/')) return true;
    }
    for (const sg of subgraphs) {
      for (const n of sg.graph.nodes) {
        if (n.kind.startsWith('anim/')) return true;
      }
    }
    return false;
  }, [mainGraph, subgraphs]);
}
