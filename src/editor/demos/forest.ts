import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { buildOakSubgraph, buildPineSubgraph } from './tree-subgraphs.js';

// Forest demo: terrain with grass-on-flats and rock-on-steeps (terrain-splat
// material kind), populated with two tree species banded by altitude.
//
// Tree definitions live in subgraphs (see tree-subgraphs.ts) — the main
// graph just instantiates `subgraph/oak-tree` and `subgraph/pine-tree`
// alongside their input clouds. Drilling into either subgraph in the editor
// reveals the trunk + foliage + materials internals.
export function createForestDemo(): { graph: Graph; rootNodeId: string; subgraphs: SubgraphDef[] } {
  const oak = buildOakSubgraph();
  const pine = buildPineSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // === Terrain ===========================================================
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: 2.5, octaves: 4, lacunarity: 2, gain: 0.5, seed: 0.3, resolution: 256 },
  });
  const heightfield = addNode(g, 'core/heightfield', {
    position: { x: COL, y: 0 },
    inputValues: { worldSize: [12, 12], heightRange: [0, 2] },
  });
  const terrainMesh = addNode(g, 'core/heightfield-to-mesh', {
    position: { x: COL * 2, y: 0 },
    inputValues: { divisions: [80, 80] },
  });
  const distribute = addNode(g, 'core/distribute-on-faces', {
    position: { x: COL * 3, y: 0 },
    inputValues: { density: 4, seed: 0.5 },
  });

  // === Masks =============================================================
  const slope = addNode(g, 'core/cloud-slope', { position: { x: COL * 4, y: 0 } });
  const slopeMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: 0 },
    inputValues: { threshold: 0.5, invert: true },
  });

  const altitude = addNode(g, 'core/cloud-altitude', {
    position: { x: COL * 4, y: ROW },
  });
  const highMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW },
    inputValues: { threshold: 1.0, invert: false },
  });
  const lowMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW * 1.6 },
    inputValues: { threshold: 1.0, invert: true },
  });
  const oakMask = addNode(g, 'core/cloud-multiply', {
    position: { x: COL * 6, y: ROW * 0.4 },
  });
  const pineMask = addNode(g, 'core/cloud-multiply', {
    position: { x: COL * 6, y: ROW * 1.4 },
  });

  // Per-tree brightness variation, shared across both species.
  const tintCloud = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 5, y: ROW * 2.2 },
    inputValues: { min: [0.65, 0.65, 0.65], max: [1.1, 1.1, 1.1], seed: 0.7 },
  });

  // === Ground material (terrain-splat: grass on flats, rock on steeps) ===
  const grassColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 1.4 },
    inputValues: { color: [0.22, 0.42, 0.16, 1], resolution: 16 },
  });
  const rockColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 2.2 },
    inputValues: { color: [0.42, 0.36, 0.32, 1], resolution: 16 },
  });
  const slopeMap = addNode(g, 'core/slope-from-height', {
    position: { x: COL * 2, y: ROW * 1.8 },
    inputValues: { strength: 6, resolution: 256 },
  });
  const groundMat = addNode(g, 'core/terrain-material', {
    position: { x: COL * 3, y: ROW * 1.8 },
    inputValues: { roughness_a: 0.95, roughness_b: 0.7 },
  });
  const terrainEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 1.8 },
  });

  // === Tree subgraph instances ===========================================
  const oakTree = addNode(g, `subgraph/${oak.id}`, {
    position: { x: COL * 7, y: ROW * 0.4 },
  });
  const pineTree = addNode(g, `subgraph/${pine.id}`, {
    position: { x: COL * 7, y: ROW * 2 },
  });

  // === Final =============================================================
  const mergeTrees = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 1.2 },
  });
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 9, y: ROW * 1.5 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 10, y: ROW * 1.5 },
    inputValues: {
      fog_density: 0.04,
      fog_color: [0.78, 0.82, 0.78, 1],
    },
  });

  // === Edges =============================================================
  // Terrain
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightfield.id, socket: 'texture' });
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: terrainMesh.id, socket: 'heightfield' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: distribute.id, socket: 'geometry' });

  // Masks
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: slope.id, socket: 'points' });
  addEdge(g, { node: slope.id, socket: 'values' }, { node: slopeMask.id, socket: 'values' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: altitude.id, socket: 'points' });
  addEdge(g, { node: altitude.id, socket: 'values' }, { node: highMask.id, socket: 'values' });
  addEdge(g, { node: altitude.id, socket: 'values' }, { node: lowMask.id, socket: 'values' });
  addEdge(g, { node: slopeMask.id, socket: 'mask' }, { node: oakMask.id, socket: 'a' });
  addEdge(g, { node: lowMask.id, socket: 'mask' }, { node: oakMask.id, socket: 'b' });
  addEdge(g, { node: slopeMask.id, socket: 'mask' }, { node: pineMask.id, socket: 'a' });
  addEdge(g, { node: highMask.id, socket: 'mask' }, { node: pineMask.id, socket: 'b' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: tintCloud.id, socket: 'points' });

  // Ground
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: slopeMap.id, socket: 'height' });
  addEdge(g, { node: grassColor.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_a' });
  addEdge(g, { node: rockColor.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_b' });
  addEdge(g, { node: slopeMap.id, socket: 'texture' }, { node: groundMat.id, socket: 'mask' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: terrainEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: terrainEntity.id, socket: 'material' });

  // Oak instance: takes points, oak mask, tint
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: oakTree.id, socket: 'points' });
  addEdge(g, { node: oakMask.id, socket: 'values' }, { node: oakTree.id, socket: 'active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: oakTree.id, socket: 'tint' });

  // Pine instance: same, with pine mask
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: pineTree.id, socket: 'points' });
  addEdge(g, { node: pineMask.id, socket: 'values' }, { node: pineTree.id, socket: 'active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: pineTree.id, socket: 'tint' });

  // Merge oaks + pines, then merge with terrain.
  addEdge(g, { node: oakTree.id, socket: 'scene' }, { node: mergeTrees.id, socket: 'a' });
  addEdge(g, { node: pineTree.id, socket: 'scene' }, { node: mergeTrees.id, socket: 'b' });
  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'a' });
  addEdge(g, { node: mergeTrees.id, socket: 'scene' }, { node: mergeAll.id, socket: 'b' });
  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id, subgraphs: [oak, pine] };
}
