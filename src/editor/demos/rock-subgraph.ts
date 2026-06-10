import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// A "rock" subgraph: a single low-poly sphere wearing the rock texture,
// at origin. NO scatter — the parent graph composes this with
// scene/instance-on-points to place rocks.
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
  // around the rock surface, not stretched once). Base radius is 1m; the
  // parent's scatter applies per-instance scale variation.
  const rockGeo = addNode(g, 'geom/sphere', {
    position: { x: COL, y: 0 },
    inputValues: { radius: 1, segments: 10, rings: 7 },
  });
  const rockUv = addNode(g, 'geom/uv-transform', {
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
  const rockMat = addNode(g, 'material/pbr', {
    position: { x: COL * 3, y: ROW * 0.7 },
    inputValues: { roughness: 0.85, metallic: 0, detail_scale: 5, detail_strength: 0.55 },
  });
  const rockEntity = addNode(g, 'scene/entity', {
    position: { x: COL * 4, y: 0 },
  });

  // Rock geometry → uv-transform → entity.
  addEdge(g, { node: rockGeo.id, socket: 'geometry' }, { node: rockUv.id, socket: 'geometry' });
  addEdge(g, { node: rockUv.id, socket: 'geometry' }, { node: rockEntity.id, socket: 'geometry' });
  // Texture subgraph → material (basecolor + normal + detail pair) → entity.material.
  addEdge(g, { node: rockTex.id, socket: 'basecolor' }, { node: rockMat.id, socket: 'basecolor' });
  addEdge(g, { node: rockTex.id, socket: 'normal' }, { node: rockMat.id, socket: 'normal' });
  addEdge(g, { node: rockTex.id, socket: 'detail_basecolor' }, { node: rockMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: rockTex.id, socket: 'detail_normal' }, { node: rockMat.id, socket: 'detail_normal' });
  addEdge(g, { node: rockMat.id, socket: 'material' }, { node: rockEntity.id, socket: 'material' });

  // Entity → boundary output.
  addEdge(g, { node: rockEntity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Rock',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
