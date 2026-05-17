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

const consumers = new Map<string, Set<string>>();
let nextId = 0;

// Number of consumers currently inside `runEval`. Sweeps are deferred
// while this is > 0 so an early-finishing consumer can't destroy cache
// entries that a sibling consumer's still-in-flight eval just
// populated (it can't have called reportWorking yet, so its
// fingerprints aren't in the union).
let activeEvals = 0;
let pendingSweep = false;

export function beginCacheEval(): void {
  activeEvals++;
}

export function endCacheEval(): void {
  if (activeEvals > 0) activeEvals--;
  if (activeEvals === 0 && pendingSweep) {
    pendingSweep = false;
    doSweepNow();
  }
}

export function reportConsumerWorkingSet(id: string, touched: Set<string>): void {
  // Copy so caller mutating their local set after this call doesn't
  // also mutate the coordinator's view (Set is shallow-mutable).
  consumers.set(id, new Set(touched));
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
  doSweepNow();
}

function doSweepNow(): void {
  const cache = useEditorStore.getState().evalCache;
  const live = new Set<string>();
  for (const s of consumers.values()) {
    for (const fp of s) live.add(fp);
  }
  sweepCache(cache, live);
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
