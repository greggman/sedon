import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { buildRockMeshSubgraph } from './rock-subgraph.js';
import {
  buildBarkTextureSubgraph,
  buildGrassTextureSubgraph,
  buildRockTextureSubgraph,
} from './texture-subgraphs.js';
import { buildOakSubgraph, buildPineSubgraph } from './tree-subgraphs.js';

// Forest demo: terrain with grass-on-flats and rock-on-steeps (terrain-splat
// material kind), populated with two tree species banded by altitude.
//
// Tree definitions live in subgraphs (see tree-subgraphs.ts) — the main
// graph just instantiates `subgraph/oak-tree` and `subgraph/pine-tree`
// alongside their input clouds. Drilling into either subgraph in the editor
// reveals the trunk + foliage + materials internals.
export function createForestDemo(): { graph: Graph; rootNodeId: string; subgraphs: SubgraphDef[] } {
  // Texture subgraphs are project-level: oak/pine reference bark, the main
  // graph references grass + rock for terrain-splat. They register first
  // so the tree wrappers can resolve `subgraph/bark-texture` at eval.
  const bark = buildBarkTextureSubgraph();
  const grass = buildGrassTextureSubgraph();
  const rock = buildRockTextureSubgraph();
  const oak = buildOakSubgraph();
  const pine = buildPineSubgraph();
  const rockMesh = buildRockMeshSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // === Terrain ===========================================================
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: [2.5, 2.5], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0.3, resolution: 256 },
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

  // === Ground material (terrain-splat: textured grass + textured rock) ====
  // Grass and rock textures are their own subgraphs — drill into "Grass
  // Texture" or "Rock Texture" via the graph switcher to inspect/tweak
  // the noise stack. Slope mask comes from slope-from-height on the same
  // perlin used for the heightfield, so rock appears where the terrain is
  // actually steep.
  const grassTex = addNode(g, 'subgraph/grass-texture', {
    position: { x: COL, y: ROW * 1.4 },
  });
  const rockTex = addNode(g, 'subgraph/rock-texture', {
    position: { x: COL, y: ROW * 2.2 },
  });
  const slopeMap = addNode(g, 'core/slope-from-height', {
    position: { x: COL * 2, y: ROW * 1.8 },
    inputValues: { strength: 6, resolution: 256 },
  });
  // tile_scale tells the terrain shader to repeat the grass/rock textures
  // densely across the mesh while keeping the slope mask at world-scale.
  const groundMat = addNode(g, 'core/terrain-material', {
    position: { x: COL * 3, y: ROW * 1.8 },
    inputValues: { roughness_a: 0.95, roughness_b: 0.7, tile_scale: [16, 16] },
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
  // Rocks scatter where trees can't grow (steep, exposed slopes).
  const rockScatter = addNode(g, `subgraph/${rockMesh.id}`, {
    position: { x: COL * 7, y: ROW * 3.6 },
  });
  // Steep mask: slope >= threshold. Same slope cloud as above, opposite
  // invert from slopeMask so it activates exactly where trees do not.
  const steepMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW * 3.6 },
    inputValues: { threshold: 0.5, invert: false },
  });
  // Slightly bigger and slightly browner rocks via per-point scale + tint.
  const rockScale = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 5, y: ROW * 4.2 },
    inputValues: { min: [0.35, 0.35, 0.35], max: [0.7, 0.55, 0.7], seed: 0.4 },
  });

  // === Final =============================================================
  const mergeTrees = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 0.8 },
  });
  const mergeVeg = addNode(g, 'core/scene-merge', {
    position: { x: COL * 9, y: ROW * 1.6 },
  });
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 10, y: ROW * 1.8 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 11, y: ROW * 1.8 },
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
  addEdge(g, { node: grassTex.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_a' });
  addEdge(g, { node: rockTex.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_b' });
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

  // Steep mask + rock scatter. Same slope cloud, opposite invert from
  // slopeMask — rocks appear precisely where trees can't.
  addEdge(g, { node: slope.id, socket: 'values' }, { node: steepMask.id, socket: 'values' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: rockScale.id, socket: 'points' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: rockScatter.id, socket: 'points' });
  addEdge(g, { node: steepMask.id, socket: 'mask' }, { node: rockScatter.id, socket: 'active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: rockScatter.id, socket: 'tint' });
  addEdge(g, { node: rockScale.id, socket: 'values' }, { node: rockScatter.id, socket: 'scale' });

  // Merge: oak+pine → trees; trees+rocks → vegetation; terrain+vegetation → all.
  addEdge(g, { node: oakTree.id, socket: 'scene' }, { node: mergeTrees.id, socket: 'a' });
  addEdge(g, { node: pineTree.id, socket: 'scene' }, { node: mergeTrees.id, socket: 'b' });
  addEdge(g, { node: mergeTrees.id, socket: 'scene' }, { node: mergeVeg.id, socket: 'a' });
  addEdge(g, { node: rockScatter.id, socket: 'scene' }, { node: mergeVeg.id, socket: 'b' });
  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'a' });
  addEdge(g, { node: mergeVeg.id, socket: 'scene' }, { node: mergeAll.id, socket: 'b' });
  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [bark, grass, rock, oak, pine, rockMesh],
  };
}
