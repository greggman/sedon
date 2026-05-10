import type { Graph } from '../core/graph.js';

// Rank-based layered auto-layout, Sugiyama-flavored. Six phases:
//
//   1. RANK ASSIGNMENT — each node's column is its longest-path distance from
//      any source, so all predecessors land to its left. DFS with cycle
//      protection (back-edges treated as sources).
//
//   2. DUMMY NODES — for any edge that spans more than one rank, insert a
//      virtual node in each intervening rank so the edge becomes a chain.
//      Dummies take up a "slot" in the column for the long edge to claim, so
//      the pack can push real nodes out of its path. Without this, a long
//      edge from rank 0 → rank 2 just runs straight through whatever happens
//      to live in rank 1, often slicing through a real node's box.
//
//   3. CROSSING MINIMIZATION — reorder nodes within each rank to reduce edge
//      crossings between adjacent ranks. Standard median-heuristic sweeps:
//      alternate down (sort each rank by median predecessor position) and up
//      (by median successor position). Converges to a near-minimum-crossings
//      ordering for the small graphs we care about. Operates on rank-position
//      indexes; Y values come from Phase 5.
//
//   4. COLUMN X — column widths come from measured node widths (default
//      otherwise) so wide preview-bearing nodes don't collide laterally.
//      Dummies don't contribute (zero width).
//
//   5. Y REFINEMENT — iteratively pulls each node (real or dummy) toward the
//      average center-Y of its neighbors (predecessors AND successors), then
//      resolves overlap via a forward+backward pack whose midpoint centers
//      each cluster around its target. Several passes converge to a layout
//      with low total edge slope.
//
//   6. WIRE-NODE OVERLAP MIN — Phase 3 only counts edge-to-edge crossings,
//      which doesn't catch a long edge passing diagonally through a tall
//      node's bounding box (a wire enters the box at the column boundary and
//      doesn't visually "cross" anything). After Y is assigned we know real
//      rectangles and wire trajectories, so we try each adjacent pair within
//      each rank, recompute Y, and keep the swap if it reduces the count of
//      (wire, node) overlaps. A few passes are enough for our graph sizes.
//
// The bidirectional pull in Phase 5 is the key bit: barycentric sort alone
// only minimizes incoming-edge slopes; without a corresponding right-to-left
// pull, columns stay top-aligned and outgoing edges to short downstream
// columns become long verticals. The forward+backward pack midpoint also
// lets clusters of nodes float to their joint target rather than getting
// jammed against the top.
//
// After Phase 6, dummies are stripped from the output so React Flow only
// sees real-node positions; the long edge it draws is straight, but it
// passes through the dummy's reserved slot rather than through a real node.
//
// Note: a long edge can still pass through a tall real node's bounding box
// even after Phase 6, if no rank-ordering swap reduces it (e.g. a single
// tall node whose vertical span dominates an entire column). Bend-point
// routing was prototyped but reverted because static waypoints stop
// tracking node positions when the user drags — looks broken. A future
// dynamic-routing approach would need to re-route on every drag.

const COL_GAP = 60;
const ROW_GAP = 30;
const DEFAULT_W = 240;
const DEFAULT_H = 140;
const REFINE_ITERATIONS = 24;
const CROSSING_SWEEPS = 16;
const SWAP_PASSES = 6;
// Dummy nodes mark a long-edge's path through an intervening rank. Their
// height controls how much vertical space the long edge "claims" in the
// intervening column — the pack will push real nodes apart from the dummy
// slot to maintain GAP. With a tiny dummy, the pack barely separates them
// and a long edge ends up grazing or just missing tall neighbors. A height
// around an average node row gives a believable buffer of clearance.
const DUMMY_HEIGHT = 120;
const DUMMY_PREFIX = '__dummy_';

export interface NodeMeasurement {
  width?: number;
  height?: number;
}

export function layoutGraph(
  graph: Graph,
  measuredById: ReadonlyMap<string, NodeMeasurement | undefined>,
): Map<string, { x: number; y: number }> {
  // Predecessors and successors per node — both needed for bidirectional
  // refinement. We mutate these later to insert dummies.
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const node of graph.nodes) {
    preds.set(node.id, []);
    succs.set(node.id, []);
  }
  for (const edge of graph.edges) {
    preds.get(edge.to.node)?.push(edge.from.node);
    succs.get(edge.from.node)?.push(edge.to.node);
  }

  // Rank = longest path from any source. DFS with cycle protection.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const computeRank = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = preds.get(id) ?? [];
    let r = 0;
    for (const p of ps) r = Math.max(r, computeRank(p) + 1);
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  for (const n of graph.nodes) computeRank(n.id);

  // Per-node measurements (real nodes only initially; dummies added below).
  const heights = new Map<string, number>();
  const widths = new Map<string, number>();
  for (const n of graph.nodes) {
    const m = measuredById.get(n.id);
    heights.set(n.id, m?.height ?? DEFAULT_H);
    widths.set(n.id, m?.width ?? DEFAULT_W);
  }

  // Phase 2: insert dummy nodes for long edges. Walk a snapshot of the
  // original edge list — we're mutating preds/succs so iterating the live
  // map would double-count.
  let dummyCounter = 0;
  for (const edge of graph.edges) {
    const fromRank = rank.get(edge.from.node);
    const toRank = rank.get(edge.to.node);
    if (fromRank === undefined || toRank === undefined) continue;
    if (toRank - fromRank <= 1) continue;

    removeOnce(succs.get(edge.from.node)!, edge.to.node);
    removeOnce(preds.get(edge.to.node)!, edge.from.node);

    let prev = edge.from.node;
    for (let r = fromRank + 1; r < toRank; r++) {
      const dummyId = `${DUMMY_PREFIX}${dummyCounter++}`;
      rank.set(dummyId, r);
      preds.set(dummyId, [prev]);
      succs.set(dummyId, []);
      heights.set(dummyId, DUMMY_HEIGHT);
      widths.set(dummyId, 0);
      succs.get(prev)!.push(dummyId);
      prev = dummyId;
    }
    succs.get(prev)!.push(edge.to.node);
    preds.get(edge.to.node)!.push(prev);
  }

  // Group all nodes (real + dummy) by rank. Map iteration is insertion order,
  // so real nodes come first in each rank — desirable starting point.
  const ranks: string[][] = [];
  for (const [id, r] of rank) {
    while (ranks.length <= r) ranks.push([]);
    ranks[r]!.push(id);
  }

  // Phase 3: crossing minimization via median-heuristic sweeps. Reorders
  // nodes within each rank to reduce edge crossings to adjacent ranks.
  for (let iter = 0; iter < CROSSING_SWEEPS; iter++) {
    const goingDown = iter % 2 === 0;
    for (let i = 0; i < ranks.length; i++) {
      const r = goingDown ? i : ranks.length - 1 - i;
      // Skip the boundary rank in each sweep direction — there's no adjacent
      // rank on that side to use as reference.
      if (goingDown && r === 0) continue;
      if (!goingDown && r === ranks.length - 1) continue;

      const adj = goingDown ? preds : succs;
      const refRank = goingDown ? r - 1 : r + 1;

      const refIndexOf = new Map<string, number>();
      ranks[refRank]!.forEach((id, idx) => refIndexOf.set(id, idx));

      const scored = ranks[r]!.map((id, originalIdx) => {
        const ns = adj.get(id) ?? [];
        const positions = ns
          .map((n) => refIndexOf.get(n))
          .filter((p): p is number => p !== undefined)
          .sort((a, b) => a - b);
        // Median of neighbor positions; nodes with no neighbors keep their
        // current position via originalIdx.
        const score = positions.length === 0
          ? originalIdx
          : positions[Math.floor(positions.length / 2)]!;
        return { id, score, originalIdx };
      });
      // Sort by median, then by previous position to keep ties stable.
      scored.sort((a, b) => a.score - b.score || a.originalIdx - b.originalIdx);
      ranks[r] = scored.map((s) => s.id);
    }
  }

  // Column widths from real-node widths; dummies contribute 0.
  const colWidth = ranks.map((ids) => {
    let max = DEFAULT_W;
    for (const id of ids) {
      const w = widths.get(id) ?? 0;
      if (w > max) max = w;
    }
    return max;
  });
  const colX: number[] = [0];
  for (let i = 1; i < ranks.length; i++) {
    colX.push(colX[i - 1]! + colWidth[i - 1]! + COL_GAP);
  }

  const positions = new Map<string, { x: number; y: number }>();
  // Compute Y values once; we'll redo this for each candidate swap below.
  assignY(ranks, colX, preds, succs, heights, positions);

  // Phase 6: minimize node-wire overlap via adjacent-pair swaps. Phase 3 only
  // counts edge-edge crossings; it can't see when an edge passes through a
  // tall node's bounding box (a different visual problem). After Y-assignment
  // we know actual rectangles and wire trajectories, so we try each adjacent
  // pair within each rank, recompute Y, and keep the swap if it reduces the
  // number of (edge, node) overlap incidents.
  const realIds = new Set<string>();
  for (const n of graph.nodes) realIds.add(n.id);
  let bestOverlaps = countWireNodeOverlaps(
    graph.edges, realIds, positions, heights, widths,
  );
  for (let pass = 0; pass < SWAP_PASSES && bestOverlaps > 0; pass++) {
    let improved = false;
    for (let r = 0; r < ranks.length; r++) {
      const rankArr = ranks[r]!;
      for (let i = 0; i < rankArr.length - 1; i++) {
        const savedOrder = rankArr.slice();
        [rankArr[i], rankArr[i + 1]] = [rankArr[i + 1]!, rankArr[i]!];
        assignY(ranks, colX, preds, succs, heights, positions);
        const overlaps = countWireNodeOverlaps(
          graph.edges, realIds, positions, heights, widths,
        );
        if (overlaps < bestOverlaps) {
          bestOverlaps = overlaps;
          improved = true;
        } else {
          ranks[r] = savedOrder;
          assignY(ranks, colX, preds, succs, heights, positions);
        }
      }
    }
    if (!improved) break;
  }

  // Strip dummies from output — the caller only knows about real nodes.
  const real = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of positions) {
    if (!id.startsWith(DUMMY_PREFIX)) real.set(id, pos);
  }
  return real;
}

// Phase 5 packaged for repeated use by Phase 6's swap-trial loop.
// Initial-stacks each rank from the top (in current rank order), then
// runs bidirectional refinement to convergence.
function assignY(
  ranks: ReadonlyArray<readonly string[]>,
  colX: ReadonlyArray<number>,
  preds: ReadonlyMap<string, readonly string[]>,
  succs: ReadonlyMap<string, readonly string[]>,
  heights: ReadonlyMap<string, number>,
  positions: Map<string, { x: number; y: number }>,
): void {
  for (let r = 0; r < ranks.length; r++) {
    let y = 0;
    for (const id of ranks[r]!) {
      positions.set(id, { x: colX[r]!, y });
      y += (heights.get(id) ?? DEFAULT_H) + ROW_GAP;
    }
  }
  for (let iter = 0; iter < REFINE_ITERATIONS; iter++) {
    for (const rankIds of ranks) {
      if (rankIds.length === 0) continue;
      refineRank(rankIds, preds, succs, positions, heights);
    }
  }
}

// Count incidents where a wire (right-handle of source → left-handle of
// target, vertically centered on each end) passes through any other real
// node's bounding box. The wire is drawn straight, so a long edge that has
// to cross intervening columns naturally enters the rectangles of nodes in
// those columns — that's exactly what we're trying to detect.
function countWireNodeOverlaps(
  graphEdges: ReadonlyArray<{ from: { node: string }; to: { node: string } }>,
  realIds: ReadonlySet<string>,
  positions: ReadonlyMap<string, { x: number; y: number }>,
  heights: ReadonlyMap<string, number>,
  widths: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (const e of graphEdges) {
    const a = positions.get(e.from.node);
    const b = positions.get(e.to.node);
    if (!a || !b) continue;
    const aw = widths.get(e.from.node) ?? DEFAULT_W;
    const ah = heights.get(e.from.node) ?? DEFAULT_H;
    const bh = heights.get(e.to.node) ?? DEFAULT_H;
    const x0 = a.x + aw;
    const y0 = a.y + ah / 2;
    const x1 = b.x;
    const y1 = b.y + bh / 2;
    for (const id of realIds) {
      if (id === e.from.node || id === e.to.node) continue;
      const pos = positions.get(id);
      if (!pos) continue;
      const w = widths.get(id) ?? DEFAULT_W;
      const h = heights.get(id) ?? DEFAULT_H;
      if (segmentRectIntersect(x0, y0, x1, y1, pos.x, pos.y, pos.x + w, pos.y + h)) {
        count++;
      }
    }
  }
  return count;
}

function segmentRectIntersect(
  ax0: number, ay0: number, ax1: number, ay1: number,
  rx0: number, ry0: number, rx1: number, ry1: number,
): boolean {
  const inside = (x: number, y: number) => x >= rx0 && x <= rx1 && y >= ry0 && y <= ry1;
  if (inside(ax0, ay0) || inside(ax1, ay1)) return true;
  // Check whether the segment crosses any of the four rectangle edges.
  return (
    segmentsIntersect(ax0, ay0, ax1, ay1, rx0, ry0, rx1, ry0) ||
    segmentsIntersect(ax0, ay0, ax1, ay1, rx1, ry0, rx1, ry1) ||
    segmentsIntersect(ax0, ay0, ax1, ay1, rx1, ry1, rx0, ry1) ||
    segmentsIntersect(ax0, ay0, ax1, ay1, rx0, ry1, rx0, ry0)
  );
}

function segmentsIntersect(
  ax0: number, ay0: number, ax1: number, ay1: number,
  bx0: number, by0: number, bx1: number, by1: number,
): boolean {
  const ccw = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (rx - px) * (qy - py) - (ry - py) * (qx - px);
  const d1 = ccw(bx0, by0, bx1, by1, ax0, ay0);
  const d2 = ccw(bx0, by0, bx1, by1, ax1, ay1);
  const d3 = ccw(ax0, ay0, ax1, ay1, bx0, by0);
  const d4 = ccw(ax0, ay0, ax1, ay1, bx1, by1);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

function removeOnce<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

// One refinement pass over a single rank: compute each node's target Y from
// the centers of its neighbors (preds + succs), sort by target, then resolve
// overlap with a forward-pass-and-backward-pass-and-average. The midpoint
// centers any "cluster" of overlap-violating nodes around their joint target
// instead of jamming them against the top — that's why this works better than
// single-direction packing.
function refineRank(
  rankIds: readonly string[],
  preds: ReadonlyMap<string, readonly string[]>,
  succs: ReadonlyMap<string, readonly string[]>,
  positions: Map<string, { x: number; y: number }>,
  heights: ReadonlyMap<string, number>,
): void {
  const items: Array<{ id: string; targetY: number; height: number }> = [];
  for (const id of rankIds) {
    const h = heights.get(id) ?? DEFAULT_H;
    const ps = preds.get(id) ?? [];
    const ss = succs.get(id) ?? [];
    const n = ps.length + ss.length;
    let targetY: number;
    if (n === 0) {
      targetY = positions.get(id)!.y;
    } else {
      let sumCenters = 0;
      for (const p of ps) {
        const pp = positions.get(p);
        if (pp) sumCenters += pp.y + (heights.get(p) ?? DEFAULT_H) / 2;
      }
      for (const s of ss) {
        const sp = positions.get(s);
        if (sp) sumCenters += sp.y + (heights.get(s) ?? DEFAULT_H) / 2;
      }
      const avgCenter = sumCenters / n;
      targetY = avgCenter - h / 2;
    }
    items.push({ id, targetY, height: h });
  }

  // No sort here — rank order is fixed by Phase 3 (crossing min) and Phase 6
  // (overlap min). Earlier versions sorted by target Y here, but that
  // silently undoes any reordering we did in those phases. Pack uses the
  // rank order as the vertical order: first item top, last item bottom.

  // Forward pass — push each node down if it would overlap its predecessor.
  const fwd: number[] = new Array(items.length);
  let cursor = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const floor = i === 0 ? -Infinity : cursor + ROW_GAP;
    const y = Math.max(it.targetY, floor);
    fwd[i] = y;
    cursor = y + it.height;
  }

  // Backward pass — pull each node up if it would overlap its successor.
  const bwd: number[] = new Array(items.length);
  cursor = +Infinity;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    const ceiling = i === items.length - 1 ? +Infinity : cursor - it.height - ROW_GAP;
    const y = Math.min(it.targetY, ceiling);
    bwd[i] = y;
    cursor = y;
  }

  // Midpoint of forward and backward. For nodes with no overlap, fwd === bwd
  // === target. For overlap clusters, averaging centers them around the
  // cluster's joint target.
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const y = (fwd[i]! + bwd[i]!) / 2;
    const x = positions.get(it.id)!.x;
    positions.set(it.id, { x, y });
  }
}
