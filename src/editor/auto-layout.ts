import type { Graph } from '../core/graph.js';

// Rank-based layered auto-layout. Each node lands in a column equal to its
// longest-path rank from any source (so all of a node's predecessors are to
// its left). Within a column, nodes are ordered by the average Y of their
// predecessors (barycentric ordering), which is a cheap-and-cheerful way to
// reduce edge crossings without running a full crossing-minimization pass.
//
// Column widths use measured node widths when available, falling back to a
// default — so wide preview-bearing nodes don't collide with their neighbors.
//
// Cycles (which shouldn't appear in a valid Sedon graph but might during
// editing) are handled by treating any back-edge target as a source for rank
// purposes, so the algorithm never infinite-loops.

const COL_GAP = 60;
const ROW_GAP = 30;
const DEFAULT_W = 240;
const DEFAULT_H = 140;

export interface NodeMeasurement {
  width?: number;
  height?: number;
}

export function layoutGraph(
  graph: Graph,
  measuredById: ReadonlyMap<string, NodeMeasurement | undefined>,
): Map<string, { x: number; y: number }> {
  // Predecessors: for each node, which nodes feed an input into it.
  const preds = new Map<string, string[]>();
  for (const node of graph.nodes) preds.set(node.id, []);
  for (const edge of graph.edges) {
    const list = preds.get(edge.to.node);
    if (list) list.push(edge.from.node);
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

  // Group by rank, preserving original order within each rank.
  const ranks: string[][] = [];
  for (const n of graph.nodes) {
    const r = rank.get(n.id) ?? 0;
    while (ranks.length <= r) ranks.push([]);
    ranks[r]!.push(n.id);
  }

  // Column widths: max measured width in each column.
  const colWidth = ranks.map((ids) => {
    let max = DEFAULT_W;
    for (const id of ids) {
      const m = measuredById.get(id);
      if (m?.width && m.width > max) max = m.width;
    }
    return max;
  });

  // Column X positions: cumulative widths + gaps.
  const colX: number[] = [0];
  for (let i = 1; i < ranks.length; i++) {
    colX.push(colX[i - 1]! + colWidth[i - 1]! + COL_GAP);
  }

  const positions = new Map<string, { x: number; y: number }>();

  // Assign Y per column. Rank 0 keeps original order; later ranks sort by
  // average predecessor Y to reduce crossings.
  for (let r = 0; r < ranks.length; r++) {
    const ids = ranks[r]!;
    let ordered: string[];
    if (r === 0) {
      ordered = ids;
    } else {
      const scored = ids.map((id) => {
        const ps = preds.get(id) ?? [];
        let sum = 0;
        let count = 0;
        for (const p of ps) {
          const pp = positions.get(p);
          if (pp) {
            sum += pp.y;
            count += 1;
          }
        }
        return { id, score: count > 0 ? sum / count : 0 };
      });
      scored.sort((a, b) => a.score - b.score);
      ordered = scored.map((s) => s.id);
    }

    let y = 0;
    for (const id of ordered) {
      const m = measuredById.get(id);
      const h = m?.height ?? DEFAULT_H;
      positions.set(id, { x: colX[r]!, y });
      y += h + ROW_GAP;
    }
  }

  return positions;
}
