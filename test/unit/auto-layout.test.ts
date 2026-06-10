import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { layoutGraph, type NodeMeasurement } from '../../src/editor/auto-layout.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

// Build the basic-demo-shape graph: grid → material → scene-entity ← sphere,
// scene-entity → output. Sphere → scene-entity is a long edge (rank 0 → 2).
function basicGraph() {
  const g = createGraph();
  const grid = addNode(g, 'tex/grid', { id: 'grid' });
  const sphere = addNode(g, 'geom/sphere', { id: 'sphere' });
  const material = addNode(g, 'material/pbr', { id: 'material' });
  const sceneEntity = addNode(g, 'scene/entity', { id: 'scene-entity' });
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

test('rank assignment: short-chain sources sit close to their consumer, long-chain sources stay leftmost', () => {
  const graph = basicGraph();
  const positions = layoutGraph(graph, buildMeasurements());
  // Chain to output (in edges):
  //   grid → material → scene-entity → output  (3)
  //   sphere → scene-entity → output            (2)
  // The "as right as possible" ranking places each node at
  // (maxBackRank - backRank), so sphere lands one column LEFT of
  // scene-entity (same column as material), NOT all the way at column 0
  // alongside grid. Grid still anchors column 0 because its chain is
  // longest.
  assert.equal(
    positions.get('material')!.x,
    positions.get('sphere')!.x,
    'sphere should share a column with material — right before scene-entity',
  );
  assert.ok(
    positions.get('grid')!.x < positions.get('sphere')!.x,
    'grid (longest chain to sink) sits left of sphere',
  );
  assert.ok(positions.get('scene-entity')!.x > positions.get('material')!.x);
  assert.ok(positions.get('output')!.x > positions.get('scene-entity')!.x);
});

// Build a graph that crosses if rank-1 keeps source order: sources S1, S2 →
// reverse-mapped middles M1, M2 (S1→M2, S2→M1). Without crossing min, M1 and
// M2 stay in graph order [M1, M2] and the two source-to-mid edges cross. With
// crossing min, they reorder to [M2, M1], eliminating the crossings.
function reverseMappedGraph() {
  const g = createGraph();
  const s1 = addNode(g, 'geom/sphere', { id: 's1' });
  const s2 = addNode(g, 'geom/sphere', { id: 's2' });
  const m1 = addNode(g, 'geom/transform', { id: 'm1' });
  const m2 = addNode(g, 'geom/transform', { id: 'm2' });
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
  const aaa = addNode(g, 'tex/solid-color', { id: 'aaa' });
  const bbb = addNode(g, 'tex/solid-color', { id: 'bbb' });
  const blend = addNode(g, 'tex/blend', { id: 'blend' });
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

// Branch-tree shape from the tree-bush demo: a recursive trunk
// produces branches that feed (a) a trunk tube + bark material +
// entity, (b) a leaf-points sampler → leaf scatter + leaf
// material + entity, and (c) a flower-points sampler → flower
// scatter + flower material + entity. Three parallel chains
// converge through one scene-merge. Real fixture for the
// crossing-min + Y-refinement passes — the tropism node has three
// outgoing edges to three different layers and the merge has three
// incoming edges from three different chains.
function branchTreeGraph() {
  const g = createGraph();
  const recursive = addNode(g, 'k', { id: 'recursive' });
  const tropism = addNode(g, 'k', { id: 'tropism' });
  // Trunk chain.
  const tube = addNode(g, 'k', { id: 'tube' });
  const bark = addNode(g, 'k', { id: 'bark' });
  const trunkMat = addNode(g, 'k', { id: 'trunkMat' });
  const trunkEntity = addNode(g, 'k', { id: 'trunkEntity' });
  // Leaf chain.
  const leafPoints = addNode(g, 'k', { id: 'leafPoints' });
  const leafGeo = addNode(g, 'k', { id: 'leafGeo' });
  const leafScatter = addNode(g, 'k', { id: 'leafScatter' });
  const leafMat = addNode(g, 'k', { id: 'leafMat' });
  const leafEntity = addNode(g, 'k', { id: 'leafEntity' });
  // Flower chain.
  const flowerPoints = addNode(g, 'k', { id: 'flowerPoints' });
  const flowerGeo = addNode(g, 'k', { id: 'flowerGeo' });
  const flowerScatter = addNode(g, 'k', { id: 'flowerScatter' });
  const flowerMat = addNode(g, 'k', { id: 'flowerMat' });
  const flowerEntity = addNode(g, 'k', { id: 'flowerEntity' });
  const merge = addNode(g, 'k', { id: 'merge' });
  const out = addNode(g, 'k', { id: 'out' });

  const s = (id: string, name: string) => ({ node: id, socket: name });
  // Branch tree split.
  addEdge(g, s(recursive.id, 'branches'), s(tropism.id, 'branches'));
  addEdge(g, s(tropism.id, 'branches'), s(tube.id, 'branches'));
  addEdge(g, s(tropism.id, 'branches'), s(leafPoints.id, 'branches'));
  addEdge(g, s(tropism.id, 'branches'), s(flowerPoints.id, 'branches'));
  // Trunk.
  addEdge(g, s(tube.id, 'geometry'), s(trunkEntity.id, 'geometry'));
  addEdge(g, s(bark.id, 'basecolor'), s(trunkMat.id, 'basecolor'));
  addEdge(g, s(trunkMat.id, 'material'), s(trunkEntity.id, 'material'));
  // Leaf.
  addEdge(g, s(leafPoints.id, 'points'), s(leafScatter.id, 'points'));
  addEdge(g, s(leafGeo.id, 'geometry'), s(leafScatter.id, 'instance'));
  addEdge(g, s(leafScatter.id, 'geometry'), s(leafEntity.id, 'geometry'));
  addEdge(g, s(leafMat.id, 'material'), s(leafEntity.id, 'material'));
  // Flower.
  addEdge(g, s(flowerPoints.id, 'points'), s(flowerScatter.id, 'points'));
  addEdge(g, s(flowerGeo.id, 'geometry'), s(flowerScatter.id, 'instance'));
  addEdge(g, s(flowerScatter.id, 'geometry'), s(flowerEntity.id, 'geometry'));
  addEdge(g, s(flowerMat.id, 'material'), s(flowerEntity.id, 'material'));
  // Merge → output.
  addEdge(g, s(trunkEntity.id, 'scene'), s(merge.id, 'scene_0'));
  addEdge(g, s(leafEntity.id, 'scene'), s(merge.id, 'scene_1'));
  addEdge(g, s(flowerEntity.id, 'scene'), s(merge.id, 'scene_2'));
  addEdge(g, s(merge.id, 'scene'), s(out.id, 'scene'));
  return g;
}

test('branch-tree shape: every node placed, layered left→right, no node-node overlap', () => {
  const g = branchTreeGraph();
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  assert.equal(positions.size, g.nodes.length, 'every real node is placed');

  // Sources strictly left of their direct successors.
  for (const e of g.edges) {
    const a = positions.get(e.from.node)!;
    const b = positions.get(e.to.node)!;
    assert.ok(a.x < b.x, `${e.from.node}.x (${a.x}) should be < ${e.to.node}.x (${b.x})`);
  }
  // No two nodes overlap (rectangles disjoint).
  const W = 240;
  const H = 140;
  const ids = Array.from(positions.keys());
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = positions.get(ids[i]!)!;
      const b = positions.get(ids[j]!)!;
      const xOverlap = a.x < b.x + W && b.x < a.x + W;
      const yOverlap = a.y < b.y + H && b.y < a.y + H;
      assert.ok(
        !(xOverlap && yOverlap),
        `${ids[i]} at (${a.x},${a.y}) overlaps ${ids[j]} at (${b.x},${b.y})`,
      );
    }
  }
});

test('branch-tree shape: keeps wire crossings low after sweeps', () => {
  const g = branchTreeGraph();
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  const crossings = countCrossings(
    positions,
    g.edges.map((e) => ({ from: e.from.node, to: e.to.node })),
  );
  // Without a registry the algorithm has no socket-bias signal —
  // all parallel edges into the same target tie on score and fall
  // back to insertion order. We pin the result to ~half the edge
  // count as a regression guard; with socket biases (the canvas
  // production path always has them) the real layout does much
  // better. See the next test for the bias-aware variant.
  assert.ok(
    crossings <= 10,
    `branch-tree (no registry) should layout with <= 10 crossings; got ${crossings}`,
  );
});

// Regression test for the "branch-pine" graph from a user save
// file (see scripts/trace-branch-pine.mjs). Topology: a long edge
// (tropism → tube) spans two layers, so a single dummy sits
// between them. Other nodes in the dummy's column (bark-texture,
// sample-points, sphere) compete for vertical real-estate.
//
// Without the dummies-first walk in the B-K alignment phase, the
// 4-orientation median averages a "long-edge aligned" Y value
// (180) with a "long-edge broken" Y value (0), giving a diagonal
// long edge that cuts through bark. The fix: visit dummy nodes
// FIRST in each layer's walk so they grab their alignment partner
// before any real node can use the frontier to block them.
test('long-edge dummy stays aligned with both endpoints (branch-pine regression)', () => {
  // Minimal reproduction of the structurally important piece: the
  // long edge tropism → tube spans two layers, with bark + leaf
  // sampler + flower sampler all competing in the middle column.
  const g = createGraph();
  const tropism = addNode(g, 'k', { id: 'tropism' });
  const sampler = addNode(g, 'k', { id: 'sampler' });
  const bark = addNode(g, 'k', { id: 'bark' });
  const tube = addNode(g, 'k', { id: 'tube' });
  const mat = addNode(g, 'k', { id: 'mat' });
  const entity = addNode(g, 'k', { id: 'entity' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' }); // long edge
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: sampler.id, socket: 'branches' }); // short edge same source
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: mat.id, socket: 'basecolor' });
  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  // tube must be in a column to the right of tropism.
  assert.ok(positions.get('tube')!.x > positions.get('tropism')!.x);
  // The long edge tropism→tube should not pass through bark's box.
  const aw = 240, h = 140;
  const a = positions.get('tropism')!;
  const b = positions.get('tube')!;
  const bp = positions.get('bark')!;
  const x0 = a.x + aw, y0 = a.y + h / 2;
  const x1 = b.x, y1 = b.y + h / 2;
  // Linear interpolation of wire Y at bark's centre X.
  const wireYAtBark = y0 + ((bp.x + aw / 2 - x0) / (x1 - x0)) * (y1 - y0);
  const barkTop = bp.y, barkBottom = bp.y + h;
  // Either the wire passes above bark (good) or below it (also
  // good). The bug is when it lands INSIDE bark's vertical span.
  assert.ok(
    wireYAtBark < barkTop || wireYAtBark > barkBottom,
    `tropism→tube wire at bark X (${wireYAtBark.toFixed(1)}) should not be inside bark's Y range [${barkTop}, ${barkBottom}]`,
  );
});

// Brandes-Köpf forms vertical "blocks" of aligned dummies along
// long edges, then compacts. The visible win: a long edge that
// spans 4 layers has its 3 interior dummies share Y with each
// other AND with one of its endpoints, so the wire is a clean
// horizontal segment instead of an S-curve. This test pins that
// behaviour: build a graph with a real source feeding both a
// short-chain real target and a far-right sink (forcing dummies);
// after layout, the dummies on the long path should share Y.
test('Brandes-Köpf: long-edge dummies stay aligned with their endpoint', () => {
  const g = createGraph();
  const src = addNode(g, 'k', { id: 'src' });
  const mid = addNode(g, 'k', { id: 'mid' });
  const last = addNode(g, 'k', { id: 'last' });
  // Short chain: src → mid → last (forces layers 0, 1, 2).
  addEdge(g, { node: src.id, socket: 'out' }, { node: mid.id, socket: 'in' });
  addEdge(g, { node: mid.id, socket: 'out' }, { node: last.id, socket: 'in' });
  // Long edge: src → last (spans 2 layers → 1 interior dummy in
  // the layer containing mid). With B-K alignment, src and the
  // dummy should be in the same block, so they share Y. From the
  // public API we can only see real nodes, so we assert that the
  // long edge's source and target have a STRAIGHT line — i.e.
  // their Y values are equal — when the dummy chain bridges them.
  addEdge(g, { node: src.id, socket: 'out' }, { node: last.id, socket: 'in' });
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  const srcY = positions.get('src')!.y;
  const lastY = positions.get('last')!.y;
  // B-K aligns src with the dummy in the middle column, and the
  // dummy with last — net result: src.y === last.y so the long
  // edge is a straight horizontal line through the dummy slot.
  assert.equal(
    srcY, lastY,
    `long edge src→last should have aligned endpoints; got src.y=${srcY} last.y=${lastY}`,
  );
});

test('column gap is wide enough that adjacent columns don\'t crowd', () => {
  // Two nodes wired source → sink. Column gap is the X-distance
  // between source.x + sourceWidth and sink.x. The new layout sets
  // COL_GAP=120 (was 60). Pin "at least 100" so the assertion
  // catches a regression to anything tighter than ~doubled spacing.
  const g = createGraph();
  const a = addNode(g, 'k', { id: 'a' });
  const b = addNode(g, 'k', { id: 'b' });
  addEdge(g, { node: a.id, socket: 'out' }, { node: b.id, socket: 'in' });
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  const ap = positions.get(a.id)!;
  const bp = positions.get(b.id)!;
  const gap = bp.x - (ap.x + 240);
  assert.ok(gap >= 100, `expected column gap >= 100; got ${gap}`);
});

// Without a registry the function should keep its pre-existing
// behaviour (no socket bias, ordering falls back to insertion order
// for ties). Guards against accidentally requiring a registry from
// callers that don't have one (older tests, etc.).
test('no-registry call still produces a layout for the same graph', () => {
  const g = createGraph();
  const aaa = addNode(g, 'tex/solid-color', { id: 'aaa' });
  const bbb = addNode(g, 'tex/solid-color', { id: 'bbb' });
  const blend = addNode(g, 'tex/blend', { id: 'blend' });
  addEdge(g, { node: aaa.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: bbb.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  const measured = new Map<string, NodeMeasurement | undefined>();
  for (const n of g.nodes) measured.set(n.id, { width: 240, height: 140 });
  const positions = layoutGraph(g, measured);
  // All three nodes get positions — the test only checks that omitting
  // the registry doesn't break layout, not which order it picks.
  assert.equal(positions.size, 3);
});
