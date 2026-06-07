import type { Graph } from '../core/graph.js';
import type { NodeRegistry } from '../core/node-def.js';

// Sugiyama-style layered auto-layout, rewritten for readability and to
// fix several long-standing issues with the prior implementation:
//
//   • Crossing reduction now alternates BARYCENTER and MEDIAN heuristics
//     across sweeps. Median is great for averaging neighbour positions
//     but stalls on tied scores; barycenter (mean) breaks those ties
//     and reaches lower-crossing orderings on graphs with parallel
//     fan-outs (e.g. the branch-tree's tropism→{tube, leaves, flowers}
//     trifecta). 32 alternating sweeps is overkill for any sane graph
//     and still finishes in milliseconds at our sizes.
//
//   • Y coordinates are now SOCKET-AWARE. The prior implementation
//     pulled each node toward the AVERAGE NODE CENTRE of its
//     neighbours; that minimises slope on average but produces a
//     visible kink at every socket whose Y didn't happen to land on
//     the centre. The new refinement treats each edge as "wire from
//     source socket Y_s to target socket Y_t" and pulls the node so
//     Y_s == Y_t — straight wires whenever the graph topology
//     allows.
//
//   • Column gap doubled (60 → 120) so wires have room to breathe and
//     wire-routing inside ReactFlow has space for cubic-Bezier curves.
//
//   • Same external API as before: `layoutGraph(graph, measuredById,
//     registry?)` returns `Map<nodeId, { x, y }>` for the real (non-
//     dummy) nodes. Callers don't change.
//
// Phase summary:
//   1. Build adjacency with per-edge source-out + target-in socket
//      bias (fraction in [0, 1)).
//   2. LAYER ASSIGNMENT — longest path to any sink, mirrored, so
//      every node hugs its consumers and only the genuinely longest
//      chains stretch to the far left.
//   3. DUMMY NODES — split edges that span > 1 layer so long wires
//      reserve their slot in intervening columns.
//   4. CROSSING REDUCTION — alternating barycenter / median sweeps,
//      ties broken by socket position.
//   5. COORDINATE ASSIGNMENT — X from column widths, Y from
//      iterative socket-aware refinement + min-gap pack.
//   6. NODE-WIRE OVERLAP MIN — adjacent-pair swaps in each layer, kept
//      if they reduce the count of wires that pass through a real
//      node's bounding box.
//   7. COMPACTION + ANCHOR — collapse oversized vertical gaps within
//      a layer, then translate the whole layout so the top-left real
//      node sits at (0, 0).

const COL_GAP = 120;
const ROW_GAP = 40;
const DEFAULT_W = 240;
const DEFAULT_H = 140;
const CROSSING_SWEEPS = 32;
const DUMMY_HEIGHT = 100;
const DUMMY_PREFIX = '__dummy_';

export interface NodeMeasurement {
  width?: number;
  height?: number;
}

// Per-edge endpoint reference used by every phase. We store the
// BIASES OF BOTH ENDS on every reference because both Y refinement
// (which needs to know "where the wire enters this node") and
// crossing reduction (which sorts by the source's out-socket Y
// among parallel edges into the same target) consume them. Keeping
// both on each EdgeRef avoids cross-lookups between preds/succs
// maps in the hot loops.
//
// socketBias is the fraction socketIndex / socketCount in [0, 1).
// 0 = topmost socket, approaching 1 = bottom-most. Used as a sub-
// integer adjustment to neighbour rank-positions in crossing
// minimisation, and as an approximate Y offset (bias * height) in
// coordinate assignment.
interface EdgeRef {
  /** The OTHER node on this edge (predecessor when in preds[T],
   *  successor when in succs[S]). */
  node: string;
  /** Source's OUT socket bias for this edge. */
  fromBias: number;
  /** Target's IN socket bias for this edge. */
  toBias: number;
}

export function layoutGraph(
  graph: Graph,
  measuredById: ReadonlyMap<string, NodeMeasurement | undefined>,
  registry?: NodeRegistry,
): Map<string, { x: number; y: number }> {
  // ─── Phase 1: adjacency + socket biases ────────────────────────
  const inputOrder = new Map<string, string[]>();
  const outputOrder = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const def = registry?.get(node.kind);
    const baseIns = def?.inputs.map((i) => i.name) ?? [];
    const extraIns = node.extraInputs?.map((i) => i.name) ?? [];
    inputOrder.set(node.id, [...baseIns, ...extraIns]);
    outputOrder.set(node.id, def?.outputs.map((o) => o.name) ?? []);
  }

  const preds = new Map<string, EdgeRef[]>();
  const succs = new Map<string, EdgeRef[]>();
  for (const node of graph.nodes) {
    preds.set(node.id, []);
    succs.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const ins = inputOrder.get(edge.to.node) ?? [];
    const outs = outputOrder.get(edge.from.node) ?? [];
    const inIdx = ins.indexOf(edge.to.socket);
    const outIdx = outs.indexOf(edge.from.socket);
    const fromBias = outIdx >= 0 && outs.length > 0 ? outIdx / outs.length : 0;
    const toBias = inIdx >= 0 && ins.length > 0 ? inIdx / ins.length : 0;
    succs.get(edge.from.node)?.push({ node: edge.to.node, fromBias, toBias });
    preds.get(edge.to.node)?.push({ node: edge.from.node, fromBias, toBias });
  }

  // ─── Phase 2: layer assignment ─────────────────────────────────
  // layer = maxBackRank − longest path to ANY sink. Sinks get the
  // largest column number (rightmost). Sources hug their consumers.
  // DFS with cycle protection; back-edges treat the cycle-closing
  // node as a sink.
  const backRank = new Map<string, number>();
  const visiting = new Set<string>();
  const computeBackRank = (id: string): number => {
    const cached = backRank.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let r = 0;
    for (const s of succs.get(id) ?? []) {
      r = Math.max(r, computeBackRank(s.node) + 1);
    }
    visiting.delete(id);
    backRank.set(id, r);
    return r;
  };
  for (const n of graph.nodes) computeBackRank(n.id);
  let maxBackRank = 0;
  for (const v of backRank.values()) if (v > maxBackRank) maxBackRank = v;
  const layer = new Map<string, number>();
  for (const [id, br] of backRank) layer.set(id, maxBackRank - br);

  // Initial measurements (heights drive Y stacking + socket Y math;
  // widths drive column widths). Dummies are added below with
  // height = DUMMY_HEIGHT, width = 0.
  const heights = new Map<string, number>();
  const widths = new Map<string, number>();
  for (const n of graph.nodes) {
    const m = measuredById.get(n.id);
    heights.set(n.id, m?.height ?? DEFAULT_H);
    widths.set(n.id, m?.width ?? DEFAULT_W);
  }

  // ─── Phase 3: dummy nodes for long edges ───────────────────────
  // Iterating graph.edges (NOT preds/succs which we mutate inside
  // the loop) so we walk a stable list. For each edge spanning more
  // than one layer, drop dummy nodes in every intervening layer and
  // re-link the chain. First-dummy carries the source's OUT bias on
  // the predecessor side; last-dummy carries the target's IN bias
  // on the successor side; intermediate hops are unbiased.
  let dummyCounter = 0;
  for (const edge of graph.edges) {
    const fromLayer = layer.get(edge.from.node);
    const toLayer = layer.get(edge.to.node);
    if (fromLayer === undefined || toLayer === undefined) continue;
    if (toLayer - fromLayer <= 1) continue;

    // Locate this specific edge's biases in the adjacency lists
    // (graphs don't have parallel edges between the same pair so
    // matching by node identity is sufficient here).
    const succIdx = succs.get(edge.from.node)!.findIndex((e) => e.node === edge.to.node);
    const predIdx = preds.get(edge.to.node)!.findIndex((e) => e.node === edge.from.node);
    const ref = succs.get(edge.from.node)![succIdx]!;
    const fromBias = ref.fromBias;
    const toBias = ref.toBias;
    succs.get(edge.from.node)!.splice(succIdx, 1);
    preds.get(edge.to.node)!.splice(predIdx, 1);

    let prev = edge.from.node;
    for (let r = fromLayer + 1; r < toLayer; r++) {
      const dummyId = `${DUMMY_PREFIX}${dummyCounter++}`;
      layer.set(dummyId, r);
      heights.set(dummyId, DUMMY_HEIGHT);
      widths.set(dummyId, 0);
      const fromBiasHop = prev === edge.from.node ? fromBias : 0;
      preds.set(dummyId, [{ node: prev, fromBias: fromBiasHop, toBias: 0 }]);
      succs.set(dummyId, []);
      succs.get(prev)!.push({ node: dummyId, fromBias: fromBiasHop, toBias: 0 });
      prev = dummyId;
    }
    // Final hop: last dummy → real target. Carry target's IN bias.
    succs.get(prev)!.push({ node: edge.to.node, fromBias: 0, toBias });
    preds.get(edge.to.node)!.push({ node: prev, fromBias: 0, toBias });
  }

  // Bucket all nodes (real + dummy) by layer.
  const layers: string[][] = [];
  for (const [id, r] of layer) {
    while (layers.length <= r) layers.push([]);
    layers[r]!.push(id);
  }

  // ─── Phase 4: crossing reduction ──────────────────────────────
  // Alternating barycenter (mean) and median sweeps, alternating
  // direction. Each iteration reorders one layer based on the
  // neighbour positions in the reference layer (previous when
  // going down, next when going up). Ties broken by previous
  // rank-position, then by node id, so the output is deterministic.
  //
  // After the global heuristic sweeps we run adjacent-pair swap
  // passes — for each (i, i+1) in each layer, swap if the swap
  // reduces the count of inter-layer edge crossings. Heuristic
  // sweeps reach a good basin; pairwise refinement crawls the rest
  // of the way to a local minimum that the basin couldn't.
  for (let iter = 0; iter < CROSSING_SWEEPS; iter++) {
    const goingDown = iter % 2 === 0;
    const useMedian = (iter >> 1) % 2 === 0; // alternate median/barycenter pairs
    for (let i = 0; i < layers.length; i++) {
      const r = goingDown ? i : layers.length - 1 - i;
      if (goingDown && r === 0) continue;
      if (!goingDown && r === layers.length - 1) continue;

      const adj = goingDown ? preds : succs;
      const refLayer = goingDown ? r - 1 : r + 1;
      const refIndex = new Map<string, number>();
      layers[refLayer]!.forEach((id, idx) => refIndex.set(id, idx));

      const scored = layers[r]!.map((id, originalIdx) => {
        const ns = adj.get(id) ?? [];
        // For an edge into THIS node from neighbour in refLayer,
        // the wire's vertical position at THIS node is the
        // neighbour's rank position plus the bias of the socket
        // on the OTHER end of the wire. When going DOWN, we're
        // sorting layer r by predecessors in r-1: the wire leaves
        // the predecessor at its OUT socket (fromBias). When going
        // UP, we sort by successors in r+1: the wire arrives at
        // the successor's IN socket (toBias).
        const positions: number[] = [];
        for (const e of ns) {
          const p = refIndex.get(e.node);
          if (p === undefined) continue;
          const bias = goingDown ? e.fromBias : e.toBias;
          positions.push(p + bias);
        }
        if (positions.length === 0) return { id, score: originalIdx, originalIdx };
        positions.sort((a, b) => a - b);
        let score: number;
        if (useMedian) {
          score = positions[Math.floor(positions.length / 2)]!;
        } else {
          let sum = 0;
          for (const p of positions) sum += p;
          score = sum / positions.length;
        }
        return { id, score, originalIdx };
      });
      scored.sort(
        (a, b) => a.score - b.score
          || a.originalIdx - b.originalIdx
          || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      layers[r] = scored.map((s) => s.id);
    }
  }

  // Adjacent-pair swap refinement plus window-2 swap (i, i+2).
  // Heuristic sweeps reach a good basin; pairwise + window-2 crawls
  // out of local minima the basin can't escape. For each layer,
  // walk pair offsets 1 and 2 and swap when the swap reduces the
  // count of inter-layer edge crossings against BOTH neighbouring
  // layers. Multiple passes until no improvement.
  const evalLayer = (r: number) =>
    layerPairCrossings(layers[r]!, r > 0 ? layers[r - 1]! : null, preds)
    + layerPairCrossings(layers[r]!, r < layers.length - 1 ? layers[r + 1]! : null, succs);
  for (let pass = 0; pass < 16; pass++) {
    let improved = false;
    for (let r = 0; r < layers.length; r++) {
      const arr = layers[r]!;
      for (const offset of [1, 2]) {
        for (let i = 0; i + offset < arr.length; i++) {
          const before = evalLayer(r);
          [arr[i], arr[i + offset]] = [arr[i + offset]!, arr[i]!];
          const after = evalLayer(r);
          if (after < before) improved = true;
          else [arr[i], arr[i + offset]] = [arr[i + offset]!, arr[i]!];
        }
      }
    }
    if (!improved) break;
  }

  // ─── Phase 5: coordinates ─────────────────────────────────────
  const colWidth = layers.map((ids) => {
    let max = DEFAULT_W;
    for (const id of ids) {
      const w = widths.get(id) ?? 0;
      if (w > max) max = w;
    }
    return max;
  });
  const colX: number[] = [0];
  for (let i = 1; i < layers.length; i++) {
    colX.push(colX[i - 1]! + colWidth[i - 1]! + COL_GAP);
  }

  const positions = new Map<string, { x: number; y: number }>();
  assignYBrandesKopf(layers, colX, preds, succs, heights, positions);

  // Phase 6 (node-wire overlap minimisation via local swaps) used
  // to live here. It was a holdover from the pre-Brandes-Köpf
  // iterative refinement, where the only way to keep a long wire
  // out of a node's bounding box was to reorder the layers around
  // it. With B-K block alignment + post-refinement barycentric,
  // long edges naturally land at their endpoint Y; the
  // overlap-min swaps only ever DEGRADE the result by introducing
  // wire crossings that the user perceives as wrong. Removed —
  // we trust the upstream phases.
  // ─── Phase 7: pull disconnected nodes toward their connected
  //              neighbours in the layer ─────────────────────────
  //
  // The post-B-K barycentric refinement spreads connected nodes
  // toward their natural Y (so e.g. a bottom scene-entity wired to
  // col 3 nodes far below sits closer to those inputs than to its
  // sibling above). The downside: a node with NO edges (a stray
  // boundary node like subgraph-input on an empty-inputs subgraph)
  // can't be pulled — it stays wherever B-K left it. Pull such
  // nodes toward the nearest connected neighbour in their layer so
  // they don't leave a gaping vertical gap.
  const hasEdge = new Set<string>();
  for (const e of graph.edges) { hasEdge.add(e.from.node); hasEdge.add(e.to.node); }
  for (const layerIds of layers) {
    if (layerIds.length < 2) continue;
    // Pull disconnected nodes DOWN toward the next connected node
    // below them in the layer (if any).
    for (let i = 0; i < layerIds.length - 1; i++) {
      const id = layerIds[i]!;
      if (hasEdge.has(id)) continue;
      // Find the next connected node below; cap our Y to its Y −
      // h − ROW_GAP so we sit tightly above it.
      for (let j = i + 1; j < layerIds.length; j++) {
        const below = layerIds[j]!;
        if (!hasEdge.has(below)) continue;
        const belowY = positions.get(below)!.y;
        const h = heights.get(id) ?? DEFAULT_H;
        const targetY = belowY - h - ROW_GAP;
        const cur = positions.get(id)!;
        if (cur.y < targetY) positions.set(id, { x: cur.x, y: targetY });
        break;
      }
    }
    // Pull disconnected nodes UP toward the previous connected node
    // above them.
    for (let i = layerIds.length - 1; i > 0; i--) {
      const id = layerIds[i]!;
      if (hasEdge.has(id)) continue;
      for (let j = i - 1; j >= 0; j--) {
        const above = layerIds[j]!;
        if (!hasEdge.has(above)) continue;
        const aboveY = positions.get(above)!.y;
        const aboveH = heights.get(above) ?? DEFAULT_H;
        const targetY = aboveY + aboveH + ROW_GAP;
        const cur = positions.get(id)!;
        if (cur.y > targetY) positions.set(id, { x: cur.x, y: targetY });
        break;
      }
    }
  }

  // Strip dummies and anchor the top-left real node to (0, 0).
  const real = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of positions) {
    if (!id.startsWith(DUMMY_PREFIX)) real.set(id, pos);
  }
  let minY = Infinity;
  for (const pos of real.values()) if (pos.y < minY) minY = pos.y;
  if (Number.isFinite(minY) && minY !== 0) {
    for (const [id, pos] of real) real.set(id, { x: pos.x, y: pos.y - minY });
  }
  return real;
}

// Count inter-layer edge crossings between `layer` and `other`.
// `direction` is the adjacency map to read FROM `layer` nodes —
// when other is the previous layer, pass `succs` so we look at
// edges into `layer`; when other is the next layer, pass `preds`
// — wait, that's not right. Let me restate: this function counts
// crossings between `layer` (the one we're optimising) and the
// adjacent `other` layer, treating wires as line segments between
// rank positions. For ANY two edges (i, j), they cross iff
// (posA(i) − posA(j)) and (posB(i) − posB(j)) have opposite signs.
//
// `adj` argument: for each node in `layer`, list its endpoints in
// `other`. When `other` is the previous layer (other = layer[r-1]),
// pass `preds`. When `other` is the next layer, pass `succs`.
function layerPairCrossings(
  layer: readonly string[],
  other: readonly string[] | null,
  adj: ReadonlyMap<string, readonly EdgeRef[]>,
): number {
  if (!other || other.length === 0) return 0;
  const otherIdx = new Map<string, number>();
  other.forEach((id, idx) => otherIdx.set(id, idx));
  // Build (posInLayer, posInOther) pairs for every edge.
  const pairs: Array<{ a: number; b: number }> = [];
  layer.forEach((id, a) => {
    for (const e of adj.get(id) ?? []) {
      const b = otherIdx.get(e.node);
      if (b !== undefined) pairs.push({ a, b });
    }
  });
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    const pi = pairs[i]!;
    for (let j = i + 1; j < pairs.length; j++) {
      const pj = pairs[j]!;
      const da = pi.a - pj.a;
      const db = pi.b - pj.b;
      if (da !== 0 && db !== 0 && Math.sign(da) !== Math.sign(db)) count++;
    }
  }
  return count;
}

// ─── Y assignment: Brandes-Köpf with socket-aware alignment ──────
//
// Brandes & Köpf 2002, "Fast and Simple Horizontal Coordinate
// Assignment", adapted to L→R flow (their "horizontal" is our
// vertical / Y). Four runs total — {top-down, bottom-up} × {prefer-
// left, prefer-right} — each producing per-node Y. Final Y is the
// median of the four. The structure of the algorithm:
//
//   1. Mark type-1 conflicts. A type-1 conflict is a crossing
//      between an INNER segment (both ends dummy → part of a long
//      edge) and a NON-INNER edge. Inner segments stay straight;
//      non-inner edges are forbidden from "claiming" the dummy on
//      the other side as an alignment partner.
//
//   2. Vertical alignment per orientation. Walk layers in the
//      orientation's direction; for each node v, attempt to align
//      with its median predecessor (or successor) u — chaining v
//      into u's block. The "left" / "right" tie-break decides which
//      median to try first when v has an even number of upper
//      neighbours. Alignment creates "blocks" — chains of nodes
//      that will share the same Y.
//
//   3. Horizontal compaction per orientation. Each block's root
//      determines the block's Y; the whole block inherits root.y.
//      Roots are placed greedily so no two nodes overlap (min gap
//      ROW_GAP between Y-adjacent nodes in any layer).
//
//   4. Balance — for each node, take the MEDIAN of the four Y
//      values. (Average of the two middle values when sorted; this
//      is what B-K calls "balancing" in the original paper.)
//
// The socket-aware target (each edge biased by socket-Y fractions)
// is folded into the alignment phase: when picking a node's median
// upper neighbour, ties are broken by predecessor position +
// fromBias. So among parallel edges into the same target, the one
// hitting the top input socket sorts above the one hitting the
// bottom — straight wires whenever the graph allows.

type Orientation = 'UL' | 'UR' | 'DL' | 'DR';
const ORIENTATIONS: Orientation[] = ['UL', 'UR', 'DL', 'DR'];

function assignYBrandesKopf(
  layers: ReadonlyArray<readonly string[]>,
  colX: ReadonlyArray<number>,
  preds: ReadonlyMap<string, readonly EdgeRef[]>,
  succs: ReadonlyMap<string, readonly EdgeRef[]>,
  heights: ReadonlyMap<string, number>,
  positions: Map<string, { x: number; y: number }>,
): void {
  if (layers.length === 0) return;

  // Position-in-layer map. Source of truth for all the index math
  // below; the layers array's order at this point reflects the
  // crossing-minimisation result.
  const posOf = new Map<string, number>();
  const layerOf = new Map<string, number>();
  for (let r = 0; r < layers.length; r++) {
    for (let i = 0; i < layers[r]!.length; i++) {
      const id = layers[r]![i]!;
      posOf.set(id, i);
      layerOf.set(id, r);
    }
  }

  const conflicts = markType1Conflicts(layers, preds, posOf);

  const results: Array<Map<string, number>> = [];
  for (const orientation of ORIENTATIONS) {
    const root = verticalAlignment(layers, preds, succs, posOf, conflicts, orientation);
    const y = horizontalCompaction(layers, root, heights, posOf, orientation);
    results.push(y);
  }

  // Balance: median of the 4 Y values per node. Following B-K, we
  // first normalise each run by aligning its min-Y to the same
  // anchor (so runs with different absolute Y baselines don't pull
  // the median apart artificially).
  const allIds: string[] = [];
  for (const layer of layers) for (const id of layer) allIds.push(id);
  let anchor = Infinity;
  for (const r of results) {
    let lo = Infinity;
    for (const v of r.values()) if (v < lo) lo = v;
    if (Number.isFinite(lo) && lo < anchor) anchor = lo;
  }
  if (!Number.isFinite(anchor)) anchor = 0;
  for (const r of results) {
    let lo = Infinity;
    for (const v of r.values()) if (v < lo) lo = v;
    if (!Number.isFinite(lo)) continue;
    const shift = anchor - lo;
    if (shift !== 0) {
      for (const [k, v] of r) r.set(k, v + shift);
    }
  }

  // Median per node.
  const finalY = new Map<string, number>();
  for (const id of allIds) {
    const vals: number[] = [];
    for (const r of results) {
      const v = r.get(id);
      if (v !== undefined) vals.push(v);
    }
    if (vals.length === 0) continue;
    vals.sort((a, b) => a - b);
    // Median of 4 = avg of middle two.
    const med = vals.length === 4
      ? (vals[1]! + vals[2]!) / 2
      : vals[Math.floor(vals.length / 2)]!;
    finalY.set(id, med);
  }

  // Final min-gap pack per layer (the median can leave residual
  // overlap when the 4 runs disagreed strongly). Pack pass respects
  // the rank order from crossing minimisation.
  for (let r = 0; r < layers.length; r++) {
    const ids = layers[r]!;
    if (ids.length === 0) continue;
    let cursor = -Infinity;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const h = heights.get(id) ?? DEFAULT_H;
      let y = finalY.get(id) ?? 0;
      const floor = i === 0 ? -Infinity : cursor + ROW_GAP;
      if (y < floor) y = floor;
      finalY.set(id, y);
      cursor = y + h;
    }
  }

  // Post-B-K barycentric refinement. B-K minimises edge LENGTH
  // subject to block constraints, which packs nodes tightly to the
  // TOP of each layer. That's correct for compactness but leaves
  // nodes "high" relative to their natural connectivity centre
  // when they have no upper-layer neighbour pulling them up — a
  // bottom scene-entity wired to col 3 nodes at y=450 and y=670
  // shouldn't sit at y=400 just because the only other node in its
  // layer happens to be small and at the top. We refine each
  // node's Y toward the average centre of its neighbours' wire
  // endpoints, bounded by the min-gap pack so ordering is
  // preserved. Long-edge alignment from B-K survives because
  // dummies' neighbours converge on the same Y the alignment
  // already chose.
  for (let iter = 0; iter < 24; iter++) {
    for (let r = 0; r < layers.length; r++) {
      refineLayerBarycentric(layers[r]!, preds, succs, finalY, heights);
    }
  }

  // Write back to positions.
  for (const id of allIds) {
    const r = layerOf.get(id)!;
    positions.set(id, { x: colX[r]!, y: finalY.get(id) ?? 0 });
  }
}

// Socket-aware barycentric refinement of a single layer. For each
// node, computes a target Y = average of "where the wire enters
// this node" across all connected neighbours, then packs the
// layer top-to-bottom and bottom-to-top, averaging the two passes
// at the end. Mirrors the iterative refinement that lived in the
// pre-B-K implementation; B-K runs first to align long edges,
// then this pass spreads non-aligned nodes toward their natural
// vertical positions.
function refineLayerBarycentric(
  layerIds: readonly string[],
  preds: ReadonlyMap<string, readonly EdgeRef[]>,
  succs: ReadonlyMap<string, readonly EdgeRef[]>,
  ys: Map<string, number>,
  heights: ReadonlyMap<string, number>,
): void {
  const items: Array<{ id: string; targetY: number; height: number }> = [];
  for (const id of layerIds) {
    const h = heights.get(id) ?? DEFAULT_H;
    const ps = preds.get(id) ?? [];
    const ss = succs.get(id) ?? [];
    let sum = 0;
    let count = 0;
    for (const p of ps) {
      const py = ys.get(p.node);
      if (py === undefined) continue;
      const ph = heights.get(p.node) ?? DEFAULT_H;
      const wireY = py + p.fromBias * ph;
      sum += wireY - p.toBias * h;
      count++;
    }
    for (const s of ss) {
      const sy = ys.get(s.node);
      if (sy === undefined) continue;
      const sh = heights.get(s.node) ?? DEFAULT_H;
      const wireY = sy + s.toBias * sh;
      sum += wireY - s.fromBias * h;
      count++;
    }
    const targetY = count === 0 ? (ys.get(id) ?? 0) : sum / count;
    items.push({ id, targetY, height: h });
  }
  // Forward pass — floor from prev node.
  const fwd: number[] = new Array(items.length);
  let cursor = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const floor = i === 0 ? -Infinity : cursor + ROW_GAP;
    const y = Math.max(it.targetY, floor);
    fwd[i] = y;
    cursor = y + it.height;
  }
  // Backward pass — ceiling from next node.
  const bwd: number[] = new Array(items.length);
  cursor = +Infinity;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    const ceiling = i === items.length - 1 ? +Infinity : cursor - it.height - ROW_GAP;
    const y = Math.min(it.targetY, ceiling);
    bwd[i] = y;
    cursor = y;
  }
  // Midpoint: centres overlap clusters on their joint target.
  for (let i = 0; i < items.length; i++) {
    ys.set(items[i]!.id, (fwd[i]! + bwd[i]!) / 2);
  }
}

// Mark type-1 conflicts per Brandes-Köpf algorithm 1. A type-1
// conflict is a crossing between an INNER segment (both ends are
// dummies, i.e. interior of a long edge) and a NON-INNER edge.
// Marked edges are forbidden from alignment in the next phase, so
// long edges stay straight.
function markType1Conflicts(
  layers: ReadonlyArray<readonly string[]>,
  preds: ReadonlyMap<string, readonly EdgeRef[]>,
  posOf: ReadonlyMap<string, number>,
): Set<string> {
  const conflicts = new Set<string>();
  const isDummy = (id: string) => id.startsWith(DUMMY_PREFIX);
  // Iterate adjacent layer pairs (upper, lower) = (k, k+1).
  for (let k = 0; k + 1 < layers.length; k++) {
    const upper = layers[k]!;
    const lower = layers[k + 1]!;
    let l = 0; // walking index into lower
    let k0 = 0; // upper-position of last inner-segment endpoint we processed
    for (let l1 = 0; l1 < lower.length; l1++) {
      // Detect inner-segment endpoint at lower[l1]: an incoming edge
      // from upper whose source is also a dummy. A dummy at l1 with
      // a dummy predecessor IS the lower end of an inner segment.
      let innerUpperPos: number | null = null;
      if (isDummy(lower[l1]!)) {
        for (const e of preds.get(lower[l1]!) ?? []) {
          if (isDummy(e.node) && layerOf(e.node, posOf, layers, k)) {
            innerUpperPos = posOf.get(e.node) ?? null;
            if (innerUpperPos !== null) break;
          }
        }
      }
      const isInnerEnd = innerUpperPos !== null;
      if (l1 === lower.length - 1 || isInnerEnd) {
        const k1 = isInnerEnd ? innerUpperPos! : upper.length - 1;
        while (l <= l1) {
          for (const e of preds.get(lower[l]!) ?? []) {
            const upos = posOf.get(e.node);
            if (upos === undefined) continue;
            // Only consider edges from the UPPER layer.
            if (layers[k]!.indexOf(e.node) < 0) continue;
            if (upos < k0 || upos > k1) {
              conflicts.add(`${e.node}|${lower[l]!}`);
            }
          }
          l++;
        }
        k0 = k1;
      }
    }
  }
  return conflicts;
}

// Local helper used only by markType1Conflicts: confirm `id` lives
// in the upper layer (layer index k). The pos+layers maps we have
// don't directly expose layer membership without iterating, so
// this short-circuits via posOf existence + checking the layer.
function layerOf(
  id: string,
  posOf: ReadonlyMap<string, number>,
  layers: ReadonlyArray<readonly string[]>,
  k: number,
): boolean {
  const p = posOf.get(id);
  if (p === undefined) return false;
  return layers[k]?.[p] === id;
}

// Vertical alignment: walk layers in the orientation's direction
// and chain each node into a block via its median neighbour in the
// adjacent layer. The orientation determines (a) iteration
// direction (top-down for U, bottom-up for D) and (b) which side
// of a two-median tie to prefer (left vs right).
//
// Returns a `root` map: node → root-of-its-block. All nodes in the
// same block share a root and will receive the same Y in
// horizontal compaction. A singleton block (no aligned partner)
// has the node itself as its root.
function verticalAlignment(
  layers: ReadonlyArray<readonly string[]>,
  preds: ReadonlyMap<string, readonly EdgeRef[]>,
  succs: ReadonlyMap<string, readonly EdgeRef[]>,
  posOf: ReadonlyMap<string, number>,
  conflicts: ReadonlySet<string>,
  orientation: Orientation,
): Map<string, string> {
  const isDown = orientation[0] === 'D';
  const isLeft = orientation[1] === 'L';
  const root = new Map<string, string>();
  const align = new Map<string, string>();
  for (const layer of layers) {
    for (const id of layer) {
      root.set(id, id);
      align.set(id, id);
    }
  }
  // Iteration order: 'U' means start with the top layer and walk
  // downward, aligning each lower node with an UPPER neighbour
  // (preds). 'D' is the reverse: bottom layer first, aligning each
  // upper node with a LOWER neighbour (succs).
  const order = isDown
    ? Array.from({ length: layers.length }, (_, i) => layers.length - 1 - i)
    : Array.from({ length: layers.length }, (_, i) => i);
  for (let oi = 0; oi < order.length; oi++) {
    const li = order[oi]!;
    // Skip the first layer in the iteration direction (no neighbour
    // layer to align with).
    if (oi === 0) continue;
    const refLi = isDown ? li + 1 : li - 1;
    const adj = isDown ? succs : preds;
    const layer = layers[li]!;
    const refLayer = layers[refLi]!;
    // Walk left-to-right (or right-to-left for the R orientations)
    // through the layer, tracking the frontier `r` = last claimed
    // position in the reference layer. Each node can only claim a
    // neighbour with a strictly greater position than r (so two
    // nodes don't aim at the same neighbour).
    // Walk order. Standard B-K iterates left-to-right (L) or
    // right-to-left (R). We override this to visit DUMMIES FIRST
    // in their L/R order — long-edge dummies should grab their
    // upper-neighbour partner before any real node can. Without
    // this, R orientations walk a real node first, claim the
    // upper neighbour with the frontier, and prevent the dummy
    // from aligning — breaking long-edge alignment. B-K's
    // standard type-1 conflict marking handles this for chains of
    // 2+ dummies (where inner segments exist) but not for short
    // long-edges spanning a single intermediate layer.
    const baseWalk = isLeft
      ? Array.from({ length: layer.length }, (_, i) => i)
      : Array.from({ length: layer.length }, (_, i) => layer.length - 1 - i);
    const dummyWalk = baseWalk.filter((i) => layer[i]!.startsWith(DUMMY_PREFIX));
    const realWalk = baseWalk.filter((i) => !layer[i]!.startsWith(DUMMY_PREFIX));
    const walk = [...dummyWalk, ...realWalk];
    let r = isLeft ? -1 : refLayer.length;
    // Walk the layer in iteration order; if a node has a dummy
    // partner available (the OTHER end of a long-edge segment), we
    // want to prefer that pairing over any real-real candidate so
    // long edges stay vertically aligned across all 4 orientations.
    // Without this prioritisation, UR/DR happily align a real node
    // with its real successor (because their walk happens to visit
    // it first), leaving the long edge's dummies in a separate
    // block — and the 4-orientation median then averages the two
    // disagreeing Y values, producing a diagonal long edge that
    // can cut through any real node in between. Brandes-Köpf's
    // standard fix is type-1 conflict marking on inner-segment
    // crossings, but short long-edges (those spanning just 2
    // layers, hence 1 dummy) have no inner segments to protect.
    // Explicit dummy-preference closes this gap.
    const isDummyId = (id: string) => id.startsWith(DUMMY_PREFIX);
    for (const k of walk) {
      const v = layer[k]!;
      const candidates = (adj.get(v) ?? [])
        .map((e) => ({ id: e.node, pos: posOf.get(e.node) ?? -1, bias: isDown ? e.toBias : e.fromBias }))
        .filter((c) => c.pos >= 0 && refLayer[c.pos] === c.id)
        .sort((a, b) => a.pos - b.pos || a.bias - b.bias);
      if (candidates.length === 0) continue;
      // Build the try-order. Dummies take priority — if `v` is a
      // dummy and any candidate is a dummy (or vice versa), try
      // the dummy candidate(s) first. Otherwise use the standard
      // L/R median preference.
      const vIsDummy = isDummyId(v);
      const m = candidates.length;
      const lowMed = Math.floor((m - 1) / 2);
      const highMed = Math.floor(m / 2);
      const dummyIdx = candidates.findIndex((c) => isDummyId(c.id));
      const standardOrder = isLeft ? [lowMed, highMed] : [highMed, lowMed];
      const tryOrder: number[] = [];
      if (vIsDummy && dummyIdx >= 0) tryOrder.push(dummyIdx);
      for (const i of standardOrder) if (!tryOrder.includes(i)) tryOrder.push(i);
      for (const mi of tryOrder) {
        if (align.get(v) !== v) break; // already aligned
        const c = candidates[mi];
        if (!c) continue;
        // Frontier check.
        if (isLeft ? c.pos <= r : c.pos >= r) continue;
        // Type-1 conflict check. Conflict keys are stored as
        // "upper|lower"; figure out which side we're on.
        const upperId = isDown ? v : c.id;
        const lowerId = isDown ? c.id : v;
        if (conflicts.has(`${upperId}|${lowerId}`)) continue;
        align.set(c.id, v);
        root.set(v, root.get(c.id)!);
        align.set(v, root.get(v)!);
        r = c.pos;
      }
    }
  }
  return root;
}

// Place each block at the smallest Y consistent with min-gap from
// the block immediately above it (in any layer the block touches).
// Iterates blocks left-to-right (block root order) and uses a
// simple greedy compaction — pessimistic compared to B-K's "class"
// machinery but a lot less code and produces good results at our
// scale.
function horizontalCompaction(
  layers: ReadonlyArray<readonly string[]>,
  root: ReadonlyMap<string, string>,
  heights: ReadonlyMap<string, number>,
  posOf: ReadonlyMap<string, number>,
  orientation: Orientation,
): Map<string, number> {
  // Group all nodes by their block root.
  const blocks = new Map<string, string[]>();
  for (const layer of layers) {
    for (const id of layer) {
      const r = root.get(id) ?? id;
      let list = blocks.get(r);
      if (!list) {
        list = [];
        blocks.set(r, list);
      }
      list.push(id);
    }
  }

  // For each layer, find the block-root of each node — used to
  // detect "block boundaries" within a layer (the node above me in
  // this layer is in a different block, so the gap matters).
  const blockOf = (id: string) => root.get(id) ?? id;

  // Compute each block's Y by walking layers in rank-position order
  // and tracking the max Y any of the block's nodes need to clear
  // the predecessor in the layer.
  const blockY = new Map<string, number>();
  for (const br of blocks.keys()) blockY.set(br, 0);

  // Iterate compaction until convergence. A block touching multiple
  // layers must satisfy MAX constraint across them, but updating
  // block Y in layer A may invalidate the constraint in layer B
  // that was already processed. Iterating until no change converges
  // because blocks only ever move DOWN (Y only increases). For our
  // graph sizes this is cheap; bound at 64 iterations as a backstop.
  //
  // All 4 orientations share this compaction — they differ in their
  // block STRUCTURE (from the alignment phase), which is what makes
  // the median balance meaningful. Without different-shaped blocks
  // per orientation the median would just collapse to one value.
  void orientation; // semantics live in alignment, not compaction
  for (let iter = 0; iter < 64; iter++) {
    let changed = false;
    for (let r = 0; r < layers.length; r++) {
      const ids = layers[r]!;
      let prevBottom = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const br = blockOf(id);
        const h = heights.get(id) ?? DEFAULT_H;
        const required = i === 0 ? 0 : prevBottom + ROW_GAP;
        const cur = blockY.get(br) ?? 0;
        if (required > cur) {
          blockY.set(br, required);
          changed = true;
        }
        prevBottom = (blockY.get(br) ?? 0) + h;
      }
    }
    if (!changed) break;
  }

  // Resolve a node's Y from its block's Y. Nodes within a block
  // share a Y; we don't model intra-block displacement here because
  // by construction every node in a block has the same socket-Y
  // alignment with its block-partner.
  const y = new Map<string, number>();
  for (const layer of layers) {
    for (const id of layer) {
      y.set(id, blockY.get(blockOf(id)) ?? 0);
    }
  }
  // Suppress unused-parameter warnings on posOf.
  void posOf;
  return y;
}

