import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { buildRockMeshSubgraph } from './rock-subgraph.js';
import type { CameraState } from '../store.js';
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
export function createForestDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
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
  // World units are meters. 100x100m terrain with up to 25m relief — a
  // small hilly area. Perlin scale ~3 gives a handful of distinct peaks
  // and valleys across that span.
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0.3, resolution: 512 },
  });
  const heightfield = addNode(g, 'core/heightfield', {
    position: { x: COL, y: 0 },
    inputValues: { worldSize: [100, 100], heightRange: [0, 25] },
  });
  const terrainMesh = addNode(g, 'core/heightfield-to-mesh', {
    position: { x: COL * 2, y: 0 },
    inputValues: { divisions: [128, 128] },
  });
  // Density 0.06 per m² over 10000 m² ≈ 600 candidate points. Slope and
  // altitude masks downstream cut this to a few hundred real placements.
  const distribute = addNode(g, 'core/distribute-on-faces', {
    position: { x: COL * 3, y: 0 },
    inputValues: { density: 0.06, seed: 0.5 },
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
  // Split oak (low) vs pine (high) at ~12m above sea level — roughly the
  // halfway mark of the 25m heightRange.
  const highMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW },
    inputValues: { threshold: 12, invert: false },
  });
  const lowMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW * 1.6 },
    inputValues: { threshold: 12, invert: true },
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
  // tile_scale: 100m terrain × tile_scale 40 → each grass/rock tile spans
  // 2.5m of world. Fine enough to read as ground detail at typical
  // viewing distances, coarse enough not to be a noisy hash.
  const groundMat = addNode(g, 'core/terrain-material', {
    position: { x: COL * 3, y: ROW * 1.8 },
    inputValues: { roughness_a: 0.95, roughness_b: 0.7, tile_scale: [40, 40] },
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
  // Rocks range from 0.8m (small loose stones) to 2.5m (proper boulders),
  // wider than tall — the squashed Y axis gives them a sat-down look
  // rather than perfect spheres.
  const rockScale = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 5, y: ROW * 4.2 },
    inputValues: { min: [0.8, 0.6, 0.8], max: [2.5, 1.5, 2.5], seed: 0.4 },
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
      // Density scaled down for the 100m world — fog fully fades distant
      // geometry by the far edge of the terrain.
      fog_density: 0.012,
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

  // Ground: textured layers (basecolor + normal each) + slope mask feed
  // the terrain-splat material. Per-layer normals give the terrain real
  // surface detail — pebble/grass-blade shadows that lit color alone can't.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: slopeMap.id, socket: 'height' });
  addEdge(g, { node: grassTex.id, socket: 'basecolor' }, { node: groundMat.id, socket: 'layer_a' });
  addEdge(g, { node: rockTex.id, socket: 'basecolor' }, { node: groundMat.id, socket: 'layer_b' });
  addEdge(g, { node: grassTex.id, socket: 'normal' }, { node: groundMat.id, socket: 'normal_a' });
  addEdge(g, { node: rockTex.id, socket: 'normal' }, { node: groundMat.id, socket: 'normal_b' });
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

  // Per-graph initial framings. With the world scaled to meters, the
  // default-distance-3 orbit would land you inside a tree trunk on main
  // and at sub-1m range on the subgraphs. These framings put each context
  // at a viewing distance appropriate for its content's scale.
  const cameras: Record<string, CameraState> = {
    main: { yaw: 0.4, pitch: 0.45, distance: 95, target: [0, 8, 0] },
    'oak-tree': { yaw: 0.5, pitch: 0.25, distance: 35, target: [0, 10, 0] },
    'pine-tree': { yaw: 0.5, pitch: 0.25, distance: 50, target: [0, 15, 0] },
    'rock-mesh': { yaw: 0.5, pitch: 0.35, distance: 4, target: [0, 0, 0] },
    'bark-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
    'grass-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
    'rock-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [bark, grass, rock, oak, pine, rockMesh],
    cameras,
  };
}
