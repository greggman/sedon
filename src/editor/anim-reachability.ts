import { useMemo } from 'react';
import type { Graph, GraphNode } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { useEditorStore } from './store.js';

// Subgraph id this node depends on for animation propagation. Two
// kinds of nodes "wrap" a subgraph for reachability purposes:
//   1. `subgraph/<sgId>` — a regular wrapper instance. The wrapped
//      subgraph's id IS the kind suffix.
//   2. `iter/*` (for-each-point / for-each-polygon) — own a private
//      "bridge" subgraph referenced by `inputValues.__bridgeId`. The
//      bridge wraps the iteration body subgraph internally, so a
//      hasAnim flag on the bridge propagates to the iter node the
//      same way it does for direct subgraph wrappers.
// Returns null when the node references no subgraph (regular leaf).
function referencedSubgraphId(node: GraphNode): string | null {
  if (node.kind.startsWith('subgraph/')) {
    return node.kind.slice('subgraph/'.length);
  }
  if (node.kind.startsWith('iter/')) {
    const id = node.inputValues?.__bridgeId;
    if (typeof id === 'string') return id;
  }
  return null;
}

// "What COULD have changed because of animation this frame?" — answered
// at the project level (main graph + all subgraphs) and consumed by the
// preview / canvas eval effects so per-animation-frame re-evals walk
// only the affected slice of the graph rather than the whole thing.
//
// Phase 1 was a project-presence gate: "no anim/* anywhere → skip the
// per-frame eval refire entirely." That handles the common case (most
// projects have no animation) and lets `scene=city` orbit at 60 fps.
// Phase 2 (this module) handles the case where animation IS present:
// build a forward-reachable set from every `anim/*` node and from every
// subgraph wrapper whose inner graph contains animation transitively;
// nodes outside that set are guaranteed to produce the same fingerprint
// frame-to-frame, so the evaluator can copy their cached output instead
// of recomputing fingerprint + checking the cache.
//
// Cross-subgraph reasoning:
//   1. A subgraph X `hasAnim` if it contains an `anim/*` node directly
//      OR a wrapper of some subgraph that itself `hasAnim`. Fixed-point
//      iteration over the subgraphs array.
//   2. Within any graph, an `anim/*` node is an "anim seed" — its
//      output literally changes per frame. A `subgraph/<sgId>` wrapper
//      whose subgraph `hasAnim` is ALSO a seed, since its inner eval
//      will re-fire per frame even if the wrapper's outer inputs stay
//      put.
//   3. A node is "affected" if it's forward-reachable from any seed
//      via the graph's edges. Forward reachability via BFS.
//
// What we deliberately don't model: per-wrapper-instance affected sets.
// Two wrappers of the same subgraph share a single affected set for
// that subgraph; the evaluator's existing per-context fingerprint
// scoping (`subgraphInputFingerprints` → trackerKey) keeps their cache
// slots separate, so reusing the set across instances is safe.

// True iff the subgraph contains an `anim/*` node anywhere in its
// transitive expansion. Map<subgraphId, boolean>; subgraphs not in the
// map are guaranteed to be false (fixed-point iteration converges and
// every key is seeded at start).
export function subgraphHasAnimMap(
  subgraphs: ReadonlyArray<SubgraphDef>,
): Map<string, boolean> {
  const flag = new Map<string, boolean>();
  for (const sg of subgraphs) flag.set(sg.id, false);
  // Iterate until nothing flips. Bounded by the project's max wrapper
  // nesting depth, typically 1–3; even a pathological 10-deep project
  // hits fixed point in 10 passes over the subgraphs array.
  let changed = true;
  while (changed) {
    changed = false;
    for (const sg of subgraphs) {
      if (flag.get(sg.id)) continue;
      const has = sg.graph.nodes.some((n) => {
        if (n.kind.startsWith('anim/')) return true;
        const refId = referencedSubgraphId(n);
        if (refId !== null) return flag.get(refId) === true;
        return false;
      });
      if (has) {
        flag.set(sg.id, true);
        changed = true;
      }
    }
  }
  return flag;
}

// Set of node ids in `graph` that are forward-reachable from an anim
// source (an `anim/*` node, or a wrapper whose subgraph `hasAnim`).
// Includes the sources themselves.
export function computeGraphAffectedSet(
  graph: Graph,
  subgraphHasAnim: ReadonlyMap<string, boolean>,
): Set<string> {
  const seeds: string[] = [];
  for (const n of graph.nodes) {
    if (n.kind.startsWith('anim/')) {
      seeds.push(n.id);
      continue;
    }
    const refId = referencedSubgraphId(n);
    if (refId !== null && subgraphHasAnim.get(refId) === true) {
      seeds.push(n.id);
    }
  }
  const affected = new Set<string>(seeds);
  let frontier = seeds;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      // Linear scan over edges. Fine for typical graph sizes (~100s
      // of edges); switch to a per-node outgoing-edge index if
      // profiling shows the BFS itself becomes hot.
      for (const e of graph.edges) {
        if (e.from.node === id && !affected.has(e.to.node)) {
          affected.add(e.to.node);
          next.push(e.to.node);
        }
      }
    }
    frontier = next;
  }
  return affected;
}

// Per-graph affected sets across the whole project. Graph id is
// `'main'` for the main graph or the subgraph's `id` otherwise.
// Subgraph wrappers' inner evals look up their affected set from
// this map (via NodeContext).
export interface ProjectAffected {
  perGraphAffected: Map<string, Set<string>>;
  subgraphHasAnim: Map<string, boolean>;
  /** Convenience: any anim seeds anywhere? Phase 1's gate becomes a
   *  derived fact here — if false, no per-frame re-eval is needed at
   *  all and the consumer can drop the dep entirely. */
  projectHasAnim: boolean;
}

export function computeProjectAffected(
  mainGraph: Graph,
  subgraphs: ReadonlyArray<SubgraphDef>,
): ProjectAffected {
  const subgraphHasAnim = subgraphHasAnimMap(subgraphs);
  const perGraphAffected = new Map<string, Set<string>>();
  const mainAffected = computeGraphAffectedSet(mainGraph, subgraphHasAnim);
  perGraphAffected.set('main', mainAffected);
  for (const sg of subgraphs) {
    perGraphAffected.set(sg.id, computeGraphAffectedSet(sg.graph, subgraphHasAnim));
  }
  // Project has anim if main has any seeds or any subgraph hasAnim
  // (the latter only matters if it's instantiated somewhere, but for
  // the conservative gate we treat "any anim anywhere" as true).
  let projectHasAnim = mainAffected.size > 0;
  if (!projectHasAnim) {
    for (const v of subgraphHasAnim.values()) {
      if (v) { projectHasAnim = true; break; }
    }
  }
  return { perGraphAffected, subgraphHasAnim, projectHasAnim };
}

// React hook: returns the project-wide affected map, memoised on
// `mainGraph` + `subgraphs` reference identity. The editor store
// replaces these arrays on any mutation (it doesn't mutate in place),
// so the memo recomputes exactly when needed.
export function useProjectAnimReachability(): ProjectAffected {
  const mainGraph = useEditorStore((s) => s.mainGraph);
  const subgraphs = useEditorStore((s) => s.subgraphs);
  return useMemo(
    () => computeProjectAffected(mainGraph, subgraphs),
    [mainGraph, subgraphs],
  );
}
