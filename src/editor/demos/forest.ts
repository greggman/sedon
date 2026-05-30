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
// Tree / rock subgraphs each define a SINGLE instance at origin (drill in
// via the graph switcher to inspect). The main graph composes them with
// `core/instance-scene-on-points` to scatter each species across the
// terrain's distribute point cloud, using masks to control where each
// kind lands. This separates "what is a tree" from "where do trees go"
// — same pattern as Houdini Copy-to-Points or Blender Geometry Nodes'
// Instance-on-Points.
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
  const heightFloat = addNode(g, 'core/texture-convert', {
    position: { x: COL, y: 0 },
    inputValues: { format: 1 },
  });
  const heightScale = addNode(g, 'core/texture-map-range', {
    position: { x: COL * 1.6, y: 0 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 25, clamp: false },
  });
  const terrainMesh = addNode(g, 'core/texture-to-heightfield-mesh', {
    position: { x: COL * 2.2, y: 0 },
    // cpu_access: the terrain mesh feeds core/distribute-on-faces below,
    // which needs CPU-side mesh data to scatter trees and rocks. Without
    // it the GPU-only mesh would be unreadable to that node.
    inputValues: { worldSize: [100, 100], divisions: [128, 128], cpu_access: true },
  });
  // Density 0.06 per m² over 10000 m² ≈ 600 candidate points. Slope and
  // altitude masks downstream cut this to a few hundred real placements.
  const distribute = addNode(g, 'core/distribute-on-faces', {
    position: { x: COL * 3, y: 0 },
    inputValues: { density: 0.01, seed: 0.5 },
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

  // === Subgraph instances ================================================
  // Each subgraph produces a single instance at origin; the scatter nodes
  // below place them onto the terrain's distribute points.
  const oakInst = addNode(g, `subgraph/${oak.id}`, {
    position: { x: COL * 7, y: ROW * 0.4 },
  });
  const pineInst = addNode(g, `subgraph/${pine.id}`, {
    position: { x: COL * 7, y: ROW * 2 },
  });
  const rockInst = addNode(g, `subgraph/${rockMesh.id}`, {
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

  // === Scatter nodes =====================================================
  // One scatter per species. Each takes (points, instance, masks/clouds)
  // and produces a Scene of N transformed copies of `instance`.
  const oakScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 8, y: ROW * 0.4 },
    inputValues: { scale: 1, align: false, seed: 1 },
  });
  const pineScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 8, y: ROW * 2 },
    inputValues: { scale: 1, align: false, seed: 2 },
  });
  const rockScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 8, y: ROW * 3.6 },
    inputValues: { scale: 1, align: false, seed: 7 },
  });

  // === Final =============================================================
  // `core/scene-merge` is variadic — pre-declare five Scene sockets so
  // every scene producer wires straight into one merge without runtime
  // "+ Add scene" clicks. Terrain + oak + pine + rock + grass.
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 11, y: ROW * 1.8 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
      { name: 'scene_4', type: 'Scene', optional: true },
    ],
  });

  // === Grass (camera-relative GPU) =======================================
  // Density = flatness (inverted slope, so grass fills level ground and
  // thins on the steep rock faces, matching the splat) × a winding trail
  // carved bare. The grass node's maxSlope adds a hard cutoff on top.
  // Type is altitude-correlated (perlin R → lush green low, dry golden
  // high), echoing the oak/pine altitude banding.
  const grassFlatness = addNode(g, 'core/slope-from-height', {
    position: { x: COL * 2, y: ROW * 5.2 },
    inputValues: { strength: 6, invert: true, resolution: 256 },
  });
  const trail = addNode(g, 'core/path-mask', {
    position: { x: COL * 2, y: ROW * 6 },
    inputValues: { angle: 35, offset: 0.45, width: 0.05, waviness: 0.14, waveScale: 1.5, resolution: 256 },
  });
  const grassDensity = addNode(g, 'core/blend', {
    position: { x: COL * 3, y: ROW * 5.6 },
    inputValues: { mode: 2, factor: 1, resolution: 256 },
  });
  const grassCardLush = addNode(g, 'core/grass-blades', {
    position: { x: COL * 2, y: ROW * 6.8 },
    inputValues: { bladeCount: 5, baseColor: [0.1, 0.28, 0.06, 1], tipColor: [0.5, 0.74, 0.28, 1], width: 1, lean: 0.2, seed: 4, resolution: 256 },
  });
  const grassCardDry = addNode(g, 'core/grass-blades', {
    position: { x: COL * 2, y: ROW * 7.6 },
    inputValues: { bladeCount: 4, baseColor: [0.34, 0.28, 0.08, 1], tipColor: [0.74, 0.62, 0.24, 1], width: 1.1, lean: 0.3, seed: 11, resolution: 256 },
  });
  const forestGrass = addNode(g, 'core/grass', {
    position: { x: COL * 4, y: ROW * 6 },
    extraInputs: [{ name: 'card_1', type: 'Texture2D', optional: true }],
    inputValues: {
      worldSize: [100, 100],
      maxDistance: 45, spacing: 0.2, bladeWidth: 0.2, bladeHeight: 0.6,
      densityScale: 1.3, maxSlope: 0.5, windStrength: 0.1, windSpeed: 2.2,
      baseColor: [0.9, 0.95, 0.85, 1], tipColor: [1, 1, 0.95, 1], colorVariation: 0.3, seed: 5,
    },
  });
  // Water pooled at altitude 12 — exactly the oak/pine altitude split,
  // so the eroded valleys flood while the higher pine band stays dry.
  // wave_strength deliberately low (0.01) and wave_scale tight (1) so
  // the surface reads as a calm forest pond rather than open sea. Foam
  // width 0.4 gives a fine ring around the shoreline + any trees that
  // happen to stand right at the waterline.
  const water = addNode(g, 'water/plane', {
    position: { x: COL * 11.5, y: ROW * 1.4 },
    inputValues: {
      water_level: 12,
      heightWorldSize: [100, 100],
      wave_strength: 0.01,
      wave_scale: 1,
      foam_width: 0.1,
      ring_speed: 0.25,
      foam_color: [0.25, 0.3, 0.4, 0.9],
    },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 12.5, y: ROW * 1.8 },
    inputValues: {
      // Density scaled down for the 100m world — fog fully fades distant
      // geometry by the far edge of the terrain.
      fog_density: 0.005,
      fog_color: [0.78, 0.82, 0.78, 1],
      bloom_intensity: 0.0001,
    },
  });

  // === Edges =============================================================
  // Terrain: perlin → texture-convert(rgba16f) → texture-map-range(0..25m)
  // → texture-to-heightfield-mesh. The float-format remap is what lets
  // the heightfield carry real-altitude values (rgba8unorm would clamp).
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightFloat.id, socket: 'texture' });
  addEdge(g, { node: heightFloat.id, socket: 'texture' }, { node: heightScale.id, socket: 'texture' });
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: terrainMesh.id, socket: 'texture' });
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

  // Oak scatter: instance the oak subgraph onto the distribute points,
  // gated by the oak mask (low altitude + flat slope), tinted per-point.
  addEdge(g, { node: oakInst.id, socket: 'scene' }, { node: oakScatter.id, socket: 'instance' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: oakScatter.id, socket: 'points' });
  addEdge(g, { node: oakMask.id, socket: 'values' }, { node: oakScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: oakScatter.id, socket: 'per_point_tint' });

  // Pine scatter: same recipe, gated by pine mask (high altitude + flat).
  addEdge(g, { node: pineInst.id, socket: 'scene' }, { node: pineScatter.id, socket: 'instance' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: pineScatter.id, socket: 'points' });
  addEdge(g, { node: pineMask.id, socket: 'values' }, { node: pineScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: pineScatter.id, socket: 'per_point_tint' });

  // Rock scatter: steep slopes where trees can't grow, with per-rock
  // scale variation for the boulder/pebble mix.
  addEdge(g, { node: slope.id, socket: 'values' }, { node: steepMask.id, socket: 'values' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: rockScale.id, socket: 'points' });
  addEdge(g, { node: rockInst.id, socket: 'scene' }, { node: rockScatter.id, socket: 'instance' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: rockScatter.id, socket: 'points' });
  addEdge(g, { node: steepMask.id, socket: 'mask' }, { node: rockScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: rockScatter.id, socket: 'per_point_tint' });
  addEdge(g, { node: rockScale.id, socket: 'values' }, { node: rockScatter.id, socket: 'per_point_scale' });

  // Merge: terrain + oak + pine + rock + grass → final scene.
  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_0' });
  addEdge(g, { node: oakScatter.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_1' });
  addEdge(g, { node: pineScatter.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_2' });
  addEdge(g, { node: rockScatter.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_3' });

  // Grass: density = flatness × trail; type by altitude; two blade cards.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: grassFlatness.id, socket: 'height' });
  addEdge(g, { node: grassFlatness.id, socket: 'texture' }, { node: grassDensity.id, socket: 'a' });
  addEdge(g, { node: trail.id, socket: 'texture' }, { node: grassDensity.id, socket: 'b' });
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: forestGrass.id, socket: 'heightTexture' });
  addEdge(g, { node: grassDensity.id, socket: 'texture' }, { node: forestGrass.id, socket: 'density' });
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: forestGrass.id, socket: 'typeMap' });
  addEdge(g, { node: grassCardLush.id, socket: 'texture' }, { node: forestGrass.id, socket: 'card_0' });
  addEdge(g, { node: grassCardDry.id, socket: 'texture' }, { node: forestGrass.id, socket: 'card_1' });
  addEdge(g, { node: forestGrass.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_4' });

  // Water takes the merged Scene, appends a water entity sized to the
  // terrain's heightfield (via the scene's terrain field), and forwards
  // straight to the output.
  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: water.id, socket: 'scene' });
  // The forest uses texture-to-heightfield-mesh + scene-entity (no
  // terrain/renderer), so the heightfield isn't carried implicitly on
  // the merged scene. Wire it directly into the water node so the
  // shader has terrain Y available for shoreline foam.
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: water.id, socket: 'heightTexture' });
  addEdge(g, { node: water.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Per-graph initial framings. With the world scaled to meters, the
  // default-distance-3 orbit would land you inside a tree trunk on main
  // and at sub-1m range on the subgraphs. These framings put each context
  // at a viewing distance appropriate for its content's scale.
  const cameras: Record<string, CameraState> = {
    main: {
      yaw: -0.18556640625,
      pitch: 0.38923828125,
      distance: 51.877070530772566,
      target: [15.689592375809005, -5.048873764467455, -14.762668633204159],
    },
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
