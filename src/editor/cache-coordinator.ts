import { useCallback, useEffect, useRef } from 'react';
import { sweepCache } from '../core/eval-cache.js';
import { useEditorStore } from './store.js';

// Cross-consumer sweep coordinator for the shared evalCache.
//
// Background: every Preview pane and every AssetThumbnail in the icon
// view runs its own `evaluateGraph` against the shared cache. Each eval
// produces a `touched` set of fingerprints used in THAT round. Calling
// sweepCache directly from any one of them destroys cache entries the
// OTHER consumers are still rendering — which manifests as "Buffer
// used in submit while destroyed" the moment you split a preview pane.
//
// Fix: instead of sweeping per-consumer, each consumer registers its
// CURRENT working set here. The coordinator unions every consumer's
// working set and sweeps with that union as the live set. An entry is
// only destroyed when zero consumers reference it any more.
//
// Lifecycle:
//   • Consumers call `reportConsumerWorkingSet(id, touched)` after each
//     successful eval. Replaces their previous set; sweep runs.
//   • Consumers call `unregisterConsumer(id)` on unmount. Sweep runs
//     again to release anything that consumer was solely protecting.
//   • The `useCacheConsumer` hook handles id generation + unmount
//     cleanup so call sites are just `reportWorking(touched)`.

// Each consumer slot carries two sets:
//   • primary  — the most-recently reported working set. Protects
//                entries the consumer's NEW eval needs.
//   • carryOver — older working set(s) the consumer reported within
//                the same frame. Protects entries the consumer's
//                PREVIOUS eval still references because React hasn't
//                committed the new outputs yet. Accumulates across
//                reports in the same frame and is cleared after the
//                next sweep rAF (by which time React has rendered).
//
// Why one frame of carryOver isn't enough on its own: a slider drag
// can fire several setInputValue → eval cycles per frame. The Nth
// report replaces primary with TN; without carryOver the (N-1)th
// set's entries would be unprotected even though React was still
// rendering against them. Accumulating carryOver until the next
// rAF sweep covers any number of in-frame reports.
interface ConsumerSlot {
  primary: Set<string>;
  carryOver: Set<string>;
}
const consumers = new Map<string, ConsumerSlot>();
let nextId = 0;

// Number of consumers currently inside `runEval`. Sweeps are deferred
// while this is > 0 so an early-finishing consumer can't destroy cache
// entries that a sibling consumer's still-in-flight eval just
// populated (it can't have called reportWorking yet, so its
// fingerprints aren't in the union).
let activeEvals = 0;
let pendingSweep = false;
// rAF handle for the currently-scheduled sweep, if any. We defer
// sweeps by one animation frame so that React has time to commit
// any setState calls that came alongside an eval's result. Without
// this, sweepCache could destroy GPU resources still referenced by
// React's previous render — components hadn't yet swapped to the new
// eval outputs, so any render-bus tick or popout-bus tick between
// reportWorking and React's commit would submit with destroyed
// textures. ("Destroyed texture used in a submit" after editing a
// node was a direct symptom of this.)
let pendingSweepFrame: number | null = null;

export function beginCacheEval(): void {
  activeEvals++;
}

export function endCacheEval(): void {
  if (activeEvals > 0) activeEvals--;
  if (activeEvals === 0 && pendingSweep) {
    pendingSweep = false;
    scheduleSweep();
  }
}

export function reportConsumerWorkingSet(id: string, touched: Set<string>): void {
  const slot = consumers.get(id);
  if (slot) {
    // Promote the existing primary into carryOver. The consumer's
    // previous outputs may still be rendered until React commits the
    // new state — keep those entries protected through the next sweep.
    for (const fp of slot.primary) slot.carryOver.add(fp);
    // Copy: shielded from caller mutation.
    slot.primary = new Set(touched);
  } else {
    consumers.set(id, { primary: new Set(touched), carryOver: new Set() });
  }
  doSweep();
}

export function unregisterConsumer(id: string): void {
  if (consumers.delete(id)) doSweep();
}

function doSweep(): void {
  if (activeEvals > 0) {
    // An eval is in flight somewhere. Its result will populate cache
    // entries that aren't yet in any consumer's working set — running
    // sweepCache now would destroy them. Mark and let endCacheEval
    // flush once everyone's done.
    pendingSweep = true;
    return;
  }
  scheduleSweep();
}

function scheduleSweep(): void {
  // Coalesce: multiple report/unregister calls within the same frame
  // schedule exactly one sweep.
  if (pendingSweepFrame !== null) return;
  pendingSweepFrame = requestAnimationFrame(() => {
    pendingSweepFrame = null;
    doSweepNow();
  });
}

function doSweepNow(): void {
  const cache = useEditorStore.getState().evalCache;
  const live = new Set<string>();
  for (const s of consumers.values()) {
    for (const fp of s.primary) live.add(fp);
    for (const fp of s.carryOver) live.add(fp);
  }
  sweepCache(cache, live);
  // CarryOver fulfilled its purpose: we're past React's commit cycle
  // (rAF runs after commit), so each consumer's previous outputs have
  // been replaced in the rendered tree. Drop them so the next sweep
  // tightens the live set.
  for (const s of consumers.values()) {
    s.carryOver.clear();
  }
}

/**
 * Hook for a component that runs `evaluateGraph` against the shared
 * cache. Returns a `reportWorking(touched)` function. The hook
 * generates a stable per-mount consumer id and unregisters it on
 * unmount, releasing anything only that consumer was holding.
 */
export function useCacheConsumer(): (touched: Set<string>) => void {
  const idRef = useRef<string | null>(null);
  if (idRef.current === null) {
    nextId++;
    idRef.current = `consumer-${nextId}`;
  }
  useEffect(() => {
    const id = idRef.current!;
    return () => unregisterConsumer(id);
  }, []);
  return useCallback((touched: Set<string>) => {
    reportConsumerWorkingSet(idRef.current!, touched);
  }, []);
}
