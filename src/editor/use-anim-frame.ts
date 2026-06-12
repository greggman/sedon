import { useEffect, useState } from 'react';
import { currentAnimFrame, subscribeAnimFrame } from './render-bus.js';

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
export function useAnimFrameGeneration(): number {
  const [gen, setGen] = useState<number>(() => currentAnimFrame());
  useEffect(() => subscribeAnimFrame((n) => setGen(n)), []);
  return gen;
}
