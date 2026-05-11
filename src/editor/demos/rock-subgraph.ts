import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// A "rock" subgraph: a single low-poly sphere wearing the rock texture,
// scattered on the input boundary's points. Same shape as the tree
// subgraphs: takes (points, active, tint), produces a Scene the parent
// merges in.
//
// Low-poly is intentional — 8 segments × 6 rings gives a faceted-enough
// silhouette to read as "rock" when scattered at small scale. Future work
// (proper perturbed icosphere primitive, per-rock variation) can replace
// the sphere without changing the surrounding wiring.
export function buildRockMeshSubgraph(): SubgraphDef {
  const id = 'rock-mesh';
  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 1.5 },
  });

  // Low-poly sphere → uv-transform (so the rock texture tiles a few times
  // around the rock surface, not stretched once). Base radius is 1m;
  // per-point scale at scatter time stretches/squashes individual rocks
  // for variety.
  const rockGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: 0 },
    inputValues: { radius: 1, segments: 10, rings: 7 },
  });
  const rockUv = addNode(g, 'core/uv-transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: { scale: [3, 2] },
  });

  // Rock texture subgraph supplies basecolor + normal AND the detail pair.
  const rockTex = addNode(g, 'subgraph/rock-texture', {
    position: { x: COL * 2, y: ROW * 1.5 },
  });
  // detail_scale + detail_strength stay on the material — they're a
  // function of how the rock mesh's UVs (post uv-transform) map to world
  // units, not a property of the rock texture itself.
  const rockMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 0.7 },
    inputValues: { roughness: 0.85, metallic: 0, detail_scale: 5, detail_strength: 0.55 },
  });
  const rockEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: 0 },
  });

  // Standalone preview: one rock at origin.
  const previewOutput = addNode(g, 'core/output', {
    position: { x: COL * 6, y: 0 },
  });

  // Scatter on the input boundary's points (parent-facing path).
  const scatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 5, y: ROW * 2.5 },
    inputValues: { scale: 1, align: false, seed: 7 },
  });

  // Rock geometry → uv-transform → entity.
  addEdge(g, { node: rockGeo.id, socket: 'geometry' }, { node: rockUv.id, socket: 'geometry' });
  addEdge(g, { node: rockUv.id, socket: 'geometry' }, { node: rockEntity.id, socket: 'geometry' });
  // Texture subgraph → material (basecolor + normal) → entity.material.
  addEdge(g, { node: rockTex.id, socket: 'basecolor' }, { node: rockMat.id, socket: 'basecolor' });
  addEdge(g, { node: rockTex.id, socket: 'normal' }, { node: rockMat.id, socket: 'normal' });
  // Detail outputs from the rock texture subgraph flow straight to the
  // material's matching inputs.
  addEdge(g, { node: rockTex.id, socket: 'detail_basecolor' }, { node: rockMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: rockTex.id, socket: 'detail_normal' }, { node: rockMat.id, socket: 'detail_normal' });
  addEdge(g, { node: rockMat.id, socket: 'material' }, { node: rockEntity.id, socket: 'material' });

  // Boundary → scatter inputs.
  addEdge(g, { node: inputNode.id, socket: 'points' }, { node: scatter.id, socket: 'points' });
  addEdge(g, { node: rockEntity.id, socket: 'scene' }, { node: scatter.id, socket: 'instance' });
  addEdge(g, { node: inputNode.id, socket: 'active' }, { node: scatter.id, socket: 'per_point_active' });
  addEdge(g, { node: inputNode.id, socket: 'tint' }, { node: scatter.id, socket: 'per_point_tint' });
  addEdge(g, { node: inputNode.id, socket: 'scale' }, { node: scatter.id, socket: 'per_point_scale' });

  // Scatter → boundary output (parent-facing).
  addEdge(g, { node: scatter.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  // Standalone preview: single rock entity → core/output.
  addEdge(g, { node: rockEntity.id, socket: 'scene' }, { node: previewOutput.id, socket: 'scene' });

  return {
    id,
    label: 'Rock',
    category: 'Subgraphs',
    inputs: [
      { name: 'points', type: 'PointCloud' },
      { name: 'active', type: 'FloatCloud', optional: true, description: 'per-point active mask; only points with value >= 0.5 are realized' },
      { name: 'tint', type: 'Vec3Cloud', optional: true, description: 'per-point RGB tint multiplier' },
      { name: 'scale', type: 'Vec3Cloud', optional: true, description: 'per-point XYZ scale multiplier; makes rocks varied sizes' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
