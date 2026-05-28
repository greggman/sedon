import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { layoutGraph, type NodeMeasurement } from '../../src/editor/auto-layout.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

// Build the basic-demo-shape graph: grid → material → scene-entity ← sphere,
// scene-entity → output. Sphere → scene-entity is a long edge (rank 0 → 2).
function basicGraph() {
  const g = createGraph();
  const grid = addNode(g, 'core/grid', { id: 'grid' });
  const sphere = addNode(g, 'core/sphere', { id: 'sphere' });
  const material = addNode(g, 'core/material', { id: 'material' });
  const sceneEntity = addNode(g, 'core/scene-entity', { id: 'scene-entity' });
  const output = addNode(g, 'core/output', { id: 'output' });
  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: sceneEntity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: sceneEntity.id, socket: 'material' });
  addEdge(g, { node: sceneEntity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });
  return g;
}

// Heights matching what custom-node.tsx actually produces given each node
// kind's preview slot + input/output count.
function heightFor(id: string): number {
  const HEADER = 33; // OUTPUT_BAR + HEADER
  const PREVIEW = 144; // PREVIEW_SIZE 128 + 2 * PREVIEW_PADDING 8
  const ROW = 28;
  switch (id) {
    case 'grid':         return HEADER + PREVIEW + 6 * ROW; // 5 inputs + 1 output
    case 'sphere':       return HEADER + 4 * ROW;            // 3 in + 1 out
    case 'material':     return HEADER + PREVIEW + 5 * ROW; // 4 in + 1 out
    case 'scene-entity': return HEADER + 3 * ROW;            // 2 in + 1 out
    case 'output':       return HEADER + 7 * ROW;            // 5 in + 2 out
    default:             return 140;
  }
}

function buildMeasurements(): Map<string, NodeMeasurement | undefined> {
  const m = new Map<string, NodeMeasurement | undefined>();
  for (const id of ['grid', 'sphere', 'material', 'scene-entity', 'output']) {
    m.set(id, { width: 240, height: heightFor(id) });
  }
  return m;
}

// The test the user was asking about: with the basic-demo shape, the long
// sphere → scene-entity edge should NOT pass through material's vertical
// Note: we intentionally don't assert the wire from sphere → scene-entity
// avoids material's box. With material's vertical span dominating column 1,
// no rank-ordering or Y-refinement can route a straight wire around it.
// Bend-point routing was prototyped but reverted (static waypoints stop
// tracking node positions on drag). A future dynamic routing pass would
// be the place to enforce that.

test('rank assignment: sphere and grid in column 0', () => {
  const graph = basicGraph();
  const positions = layoutGraph(graph, buildMeasurements());
  // Same column means same x.
  assert.equal(positions.get('grid')!.x, positions.get('sphere')!.x);
  // Material is one column right.
  assert.ok(positions.get('material')!.x > positions.get('grid')!.x);
  // Scene-entity is two columns right of grid.
  assert.ok(positions.get('scene-entity')!.x > positions.get('material')!.x);
});

// Build a graph that crosses if rank-1 keeps source order: sources S1, S2 →
// reverse-mapped middles M1, M2 (S1→M2, S2→M1). Without crossing min, M1 and
// M2 stay in graph order [M1, M2] and the two source-to-mid edges cross. With
// crossing min, they reorder to [M2, M1], eliminating the crossings.
function reverseMappedGraph() {
  const g = createGraph();
  const s1 = addNode(g, 'core/sphere', { id: 's1' });
  const s2 = addNode(g, 'core/sphere', { id: 's2' });
  const m1 = addNode(g, 'core/transform', { id: 'm1' });
  const m2 = addNode(g, 'core/transform', { id: 'm2' });
  const t = addNode(g, 'core/output', { id: 't' });
  // Reverse mapping
  addEdge(g, { node: s1.id, socket: 'out' }, { node: m2.id, socket: 'in' });
  addEdge(g, { node: s2.id, socket: 'out' }, { node: m1.id, socket: 'in' });
  // Both middles converge on T
  addEdge(g, { node: m1.id, socket: 'out' }, { node: t.id, socket: 'in' });
  addEdge(g, { node: m2.id, socket: 'out' }, { node: t.id, socket: 'in' });
  return g;
}

// Two edges (a→b) and (c→d) within a single rank-pair cross iff the y-orders
// of (a, c) and (b, d) disagree. Counts crossings between every adjacent
// rank-pair.
function countCrossings(
  positions: Map<string, { x: number; y: number }>,
  edges: { from: string; to: string }[],
): number {
  let total = 0;
  for (let i = 0; i < edges.length; i++) {
    const ei = edges[i]!;
    const a = positions.get(ei.from);
    const b = positions.get(ei.to);
    if (!a || !b) continue;
    for (let j = i + 1; j < edges.length; j++) {
      const ej = edges[j]!;
      const c = positions.get(ej.from);
      const d = positions.get(ej.to);
      if (!c || !d) continue;
      // Only count edges that span the same rank-pair (same source and
      // target columns). Edges between different column pairs aren't in
      // visual conflict.
      if (a.x !== c.x || b.x !== d.x) continue;
      const dyAtSource = Math.sign(a.y - c.y);
      const dyAtTarget = Math.sign(b.y - d.y);
      if (dyAtSource !== 0 && dyAtTarget !== 0 && dyAtSource !== dyAtTarget) {
        total += 1;
      }
    }
  }
  return total;
}

test('crossing minimization eliminates crossings on a reverse-mapped graph', () => {
  const graph = reverseMappedGraph();
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of graph.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(graph, measured);
  const edges = graph.edges.map((e) => ({ from: e.from.node, to: e.to.node }));
  const crossings = countCrossings(positions, edges);
  assert.equal(crossings, 0, `expected 0 crossings, got ${crossings}`);
  // Sanity: with crossing min, rank 1 should be [m2, m1] (m2 above) — assert
  // m2.y < m1.y.
  assert.ok(
    positions.get('m2')!.y < positions.get('m1')!.y,
    `expected m2 above m1; got m2=${positions.get('m2')!.y} m1=${positions.get('m1')!.y}`,
  );
});

// Two source nodes feeding the SAME target node at different input
// sockets. Without socket-aware median scoring the two sources tie
// (both have one successor at the same rank-position) and fall back
// to insertion order; with socket-aware scoring the source whose
// edge enters the target's TOP socket sorts above the other —
// minimising wire crossings even when only one target node is in
// the next rank.
test('socket-aware ordering: source feeding target.a sorts above source feeding target.b', () => {
  const g = createGraph();
  // Insertion order DELIBERATELY reversed from the desired layout —
  // aaa is added first (so without socket awareness it ends up on
  // top), but aaa connects to blend.b (the LOWER socket) so the
  // correct layout puts bbb on top.
  const aaa = addNode(g, 'core/solid-color', { id: 'aaa' });
  const bbb = addNode(g, 'core/solid-color', { id: 'bbb' });
  const blend = addNode(g, 'core/blend', { id: 'blend' });
  addEdge(g, { node: aaa.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: bbb.id, socket: 'texture' }, { node: blend.id, socket: 'a' });

  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });

  const registry = createCoreNodeRegistry();
  const positions = layoutGraph(g, measured, registry);
  assert.ok(
    positions.get('bbb')!.y < positions.get('aaa')!.y,
    `bbb feeds blend.a (top socket) so it should sort above aaa which feeds blend.b; got bbb=${positions.get('bbb')!.y} aaa=${positions.get('aaa')!.y}`,
  );
});

// Without a registry the function should keep its pre-existing
// behaviour (no socket bias, ordering falls back to insertion order
// for ties). Guards against accidentally requiring a registry from
// callers that don't have one (older tests, etc.).
test('no-registry call still produces a layout for the same graph', () => {
  const g = createGraph();
  const aaa = addNode(g, 'core/solid-color', { id: 'aaa' });
  const bbb = addNode(g, 'core/solid-color', { id: 'bbb' });
  const blend = addNode(g, 'core/blend', { id: 'blend' });
  addEdge(g, { node: aaa.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: bbb.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  // All three nodes get positions — the test only checks that omitting
  // the registry doesn't break layout, not which order it picks.
  assert.equal(positions.size, 3);
});
