import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';

// Forest demo with two tree species banded by altitude. Same terrain
// pipeline as before (perlin → heightfield → mesh → distribute), but the
// per-point active mask combines a slope filter (gentle ground only) with
// an altitude split:
//
//   oak  = (slope < 0.5 rad)  AND  (altitude < 1.0)   — broad-leaf, low ground
//   pine = (slope < 0.5 rad)  AND  (altitude >= 1.0)  — conifer, higher ground
//
// Each species is its own tree subgraph (oak: cylinder + sphere, pine:
// cylinder + cone) instanced via core/instance-scene-on-points. Both share
// the per-point tint cloud for brightness variation. Renders as 5 draws
// total: 1 terrain + 2 oak (trunk, foliage) + 2 pine (trunk, foliage).
export function createForestDemo(): { graph: Graph; rootNodeId: string } {
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
  // Slope below ~28° (0.5 rad) → tree-allowed.
  const slopeMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: 0 },
    inputValues: { threshold: 0.5, invert: true },
  });

  const altitude = addNode(g, 'core/cloud-altitude', {
    position: { x: COL * 4, y: ROW },
  });
  // High band: altitude >= 1.0 → 1.
  const highMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW },
    inputValues: { threshold: 1.0, invert: false },
  });
  // Low band: altitude < 1.0 → 1.
  const lowMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: ROW * 1.6 },
    inputValues: { threshold: 1.0, invert: true },
  });
  // AND-combine: oak = slope-OK ∧ low-altitude; pine = slope-OK ∧ high-altitude.
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

  // === Ground material (terrain-splat kind: grass on flats, rock on steeps) ===
  const grassColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 1.4 },
    inputValues: { color: [0.22, 0.42, 0.16, 1], resolution: 16 },
  });
  const rockColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 2.2 },
    inputValues: { color: [0.42, 0.36, 0.32, 1], resolution: 16 },
  });
  // Slope mask derived from the same heightfield; steep regions read as
  // rock, flat as grass.
  const slopeMap = addNode(g, 'core/slope-from-height', {
    position: { x: COL * 2, y: ROW * 1.8 },
    inputValues: { strength: 6, resolution: 256 },
  });
  // The terrain material is its own material kind — the renderer dispatches
  // to a different shader pipeline (terrain-splat.wgsl) than for PBR
  // materials, with per-layer roughness so the rock layer is glossier than
  // grass even though both share an albedo blend.
  const groundMat = addNode(g, 'core/terrain-material', {
    position: { x: COL * 3, y: ROW * 1.8 },
    inputValues: { roughness_a: 0.95, roughness_b: 0.7 },
  });
  const terrainEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 1.8 },
  });

  // === Oak subgraph (cylinder trunk + sphere foliage) ====================
  const oakTrunk = addNode(g, 'core/cylinder', {
    position: { x: 0, y: ROW * 3 },
    inputValues: { radius: 0.08, height: 0.9, segments: 10 },
  });
  const oakTrunkColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { color: [0.32, 0.2, 0.1, 1], resolution: 16 },
  });
  const oakTrunkMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });
  const oakTrunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3 },
  });

  const oakLeaf = addNode(g, 'core/sphere', {
    position: { x: 0, y: ROW * 4 },
    inputValues: { radius: 0.4, segments: 16, rings: 12 },
  });
  const oakLeafLift = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 4 },
    inputValues: { translate: [0, 1.05, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const oakLeafColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 2, y: ROW * 4.5 },
    inputValues: { color: [0.22, 0.5, 0.16, 1], resolution: 16 },
  });
  const oakLeafMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 4.5 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const oakLeafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 4 },
  });

  const oakTree = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 3.5 },
  });
  const oakScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 6, y: ROW * 3.5 },
    inputValues: { scale: 1, align: false, seed: 1 },
  });

  // === Pine subgraph (cylinder trunk + cone foliage) =====================
  const pineTrunk = addNode(g, 'core/cylinder', {
    position: { x: 0, y: ROW * 6 },
    inputValues: { radius: 0.07, height: 0.55, segments: 10 },
  });
  const pineTrunkColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 6 },
    inputValues: { color: [0.28, 0.18, 0.09, 1], resolution: 16 },
  });
  const pineTrunkMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 6 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });
  const pineTrunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 6 },
  });

  const pineCone = addNode(g, 'core/cone', {
    position: { x: 0, y: ROW * 7 },
    inputValues: { radius: 0.5, height: 1.6, segments: 14 },
  });
  const pineConeLift = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 7 },
    inputValues: { translate: [0, 0.3, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const pineLeafColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 2, y: ROW * 7.5 },
    inputValues: { color: [0.1, 0.32, 0.18, 1], resolution: 16 },
  });
  const pineLeafMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 7.5 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const pineLeafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 7 },
  });

  const pineTree = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 6.5 },
  });
  const pineScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 6, y: ROW * 6.5 },
    inputValues: { scale: 1, align: false, seed: 2 },
  });

  // === Final =============================================================
  const mergeOaks = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 2.5 },
  });
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 2 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 9, y: ROW * 2 },
    inputValues: {
      // Subtle horizon fog — far trees blend into the sky for atmospheric
      // depth. Color matches the default sky bottom so the fade is seamless.
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

  // Ground: layers + slope mask feed straight into the terrain-splat material.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: slopeMap.id, socket: 'height' });
  addEdge(g, { node: grassColor.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_a' });
  addEdge(g, { node: rockColor.id, socket: 'texture' }, { node: groundMat.id, socket: 'layer_b' });
  addEdge(g, { node: slopeMap.id, socket: 'texture' }, { node: groundMat.id, socket: 'mask' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: terrainEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: terrainEntity.id, socket: 'material' });

  // Oak
  addEdge(g, { node: oakTrunk.id, socket: 'geometry' }, { node: oakTrunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: oakTrunkColor.id, socket: 'texture' }, { node: oakTrunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: oakTrunkMat.id, socket: 'material' }, { node: oakTrunkEntity.id, socket: 'material' });
  addEdge(g, { node: oakLeaf.id, socket: 'geometry' }, { node: oakLeafLift.id, socket: 'geometry' });
  addEdge(g, { node: oakLeafLift.id, socket: 'geometry' }, { node: oakLeafEntity.id, socket: 'geometry' });
  addEdge(g, { node: oakLeafColor.id, socket: 'texture' }, { node: oakLeafMat.id, socket: 'basecolor' });
  addEdge(g, { node: oakLeafMat.id, socket: 'material' }, { node: oakLeafEntity.id, socket: 'material' });
  addEdge(g, { node: oakTrunkEntity.id, socket: 'scene' }, { node: oakTree.id, socket: 'a' });
  addEdge(g, { node: oakLeafEntity.id, socket: 'scene' }, { node: oakTree.id, socket: 'b' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: oakScatter.id, socket: 'points' });
  addEdge(g, { node: oakTree.id, socket: 'scene' }, { node: oakScatter.id, socket: 'instance' });
  addEdge(g, { node: oakMask.id, socket: 'values' }, { node: oakScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: oakScatter.id, socket: 'per_point_tint' });

  // Pine
  addEdge(g, { node: pineTrunk.id, socket: 'geometry' }, { node: pineTrunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: pineTrunkColor.id, socket: 'texture' }, { node: pineTrunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: pineTrunkMat.id, socket: 'material' }, { node: pineTrunkEntity.id, socket: 'material' });
  addEdge(g, { node: pineCone.id, socket: 'geometry' }, { node: pineConeLift.id, socket: 'geometry' });
  addEdge(g, { node: pineConeLift.id, socket: 'geometry' }, { node: pineLeafEntity.id, socket: 'geometry' });
  addEdge(g, { node: pineLeafColor.id, socket: 'texture' }, { node: pineLeafMat.id, socket: 'basecolor' });
  addEdge(g, { node: pineLeafMat.id, socket: 'material' }, { node: pineLeafEntity.id, socket: 'material' });
  addEdge(g, { node: pineTrunkEntity.id, socket: 'scene' }, { node: pineTree.id, socket: 'a' });
  addEdge(g, { node: pineLeafEntity.id, socket: 'scene' }, { node: pineTree.id, socket: 'b' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: pineScatter.id, socket: 'points' });
  addEdge(g, { node: pineTree.id, socket: 'scene' }, { node: pineScatter.id, socket: 'instance' });
  addEdge(g, { node: pineMask.id, socket: 'values' }, { node: pineScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: pineScatter.id, socket: 'per_point_tint' });

  // Final
  addEdge(g, { node: oakScatter.id, socket: 'scene' }, { node: mergeOaks.id, socket: 'a' });
  addEdge(g, { node: pineScatter.id, socket: 'scene' }, { node: mergeOaks.id, socket: 'b' });
  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'a' });
  addEdge(g, { node: mergeOaks.id, socket: 'scene' }, { node: mergeAll.id, socket: 'b' });
  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id };
}
