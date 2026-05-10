import type { Graph } from '../core/graph.js';

// Rank-based layered auto-layout, Sugiyama-flavored. Three phases:
//
//   1. RANK ASSIGNMENT — each node's column is its longest-path distance from
//      any source, so all predecessors land to its left. DFS with cycle
//      protection (back-edges treated as sources).
//
//   2. COLUMN X — column widths come from measured node widths (default
//      otherwise) so wide preview-bearing nodes don't collide laterally.
//
//   3. Y REFINEMENT — iteratively pulls each node toward the average center-Y
//      of its neighbors (predecessors AND successors), then resolves overlap
//      via a forward+backward pack whose midpoint centers each cluster around
//      its target. Several passes converge to a layout with low total edge
//      slope, which is what the eye reads as "clean."
//
// The bidirectional pull is the key bit: barycentric sort alone (sweep
// left-to-right) only minimizes incoming-edge slopes; without a corresponding
// right-to-left pull, columns stay top-aligned and outgoing edges to short
// downstream columns become long verticals. Averaging predecessor and
// successor influence per iteration handles both at once, and the forward+
// backward pack midpoint lets clusters of nodes float to their joint target
// rather than getting jammed against the top.

const COL_GAP = 60;
const ROW_GAP = 30;
const DEFAULT_W = 240;
const DEFAULT_H = 140;
const REFINE_ITERATIONS = 24;

export interface NodeMeasurement {
  width?: number;
  height?: number;
}

export function layoutGraph(
  graph: Graph,
  measuredById: ReadonlyMap<string, NodeMeasurement | undefined>,
): Map<string, { x: number; y: number }> {
  // Predecessors and successors per node — both needed for bidirectional
  // refinement.
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

  // Group by rank, preserving original graph order within each rank.
  const ranks: string[][] = [];
  for (const n of graph.nodes) {
    const r = rank.get(n.id) ?? 0;
    while (ranks.length <= r) ranks.push([]);
    ranks[r]!.push(n.id);
  }

  // Per-node height lookup — used by both initial stacking and refinement.
  const heights = new Map<string, number>();
  for (const n of graph.nodes) {
    heights.set(n.id, measuredById.get(n.id)?.height ?? DEFAULT_H);
  }

  // Column widths and X positions.
  const colWidth = ranks.map((ids) => {
    let max = DEFAULT_W;
    for (const id of ids) {
      const m = measuredById.get(id);
      if (m?.width && m.width > max) max = m.width;
    }
    return max;
  });
  const colX: number[] = [0];
  for (let i = 1; i < ranks.length; i++) {
    colX.push(colX[i - 1]! + colWidth[i - 1]! + COL_GAP);
  }

  // Initial Y: stack from top in graph order. Refinement will rearrange.
  const positions = new Map<string, { x: number; y: number }>();
  for (let r = 0; r < ranks.length; r++) {
    let y = 0;
    for (const id of ranks[r]!) {
      positions.set(id, { x: colX[r]!, y });
      y += (heights.get(id) ?? DEFAULT_H) + ROW_GAP;
    }
  }

  // Phase 3: bidirectional Y refinement.
  for (let iter = 0; iter < REFINE_ITERATIONS; iter++) {
    for (const rankIds of ranks) {
      if (rankIds.length === 0) continue;
      refineRank(rankIds, preds, succs, positions, heights);
    }
  }

  return positions;
}

// One refinement pass over a single rank: compute each node's target Y from
// the centers of its neighbors (preds + succs), sort by target, then resolve
// overlap with a forward-pass-and-backward-pass-and-average. The midpoint
// centers any "cluster" of overlap-violating nodes around their joint target
// instead of jamming them against the top — that's why this works better than
// single-direction packing.
function refineRank(
  rankIds: string[],
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

  // Sort ascending by target Y. Ties: stable on id so layout is deterministic.
  items.sort((a, b) => a.targetY - b.targetY || a.id.localeCompare(b.id));

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
