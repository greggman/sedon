import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';

// Forest demo: perlin → heightfield → terrain mesh, then a tree subgraph
// (cylinder trunk + sphere foliage with their own materials, merged into a
// 2-entity Scene) is scattered on the terrain via slope-filtered points.
// Trunks and foliage each batch into one instanced draw call, so a forest of
// hundreds of trees + the terrain renders in 3 draws total.
export function createForestDemo(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const COL = 280;
  const ROW = 180;

  // Terrain row.
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
  const slope = addNode(g, 'core/cloud-slope', {
    position: { x: COL * 4, y: 0 },
  });
  // Slope below ~28° (0.5 rad) → tree, otherwise bare rock. invert=true
  // selects "below threshold."
  const slopeMask = addNode(g, 'core/cloud-step', {
    position: { x: COL * 5, y: 0 },
    inputValues: { threshold: 0.5, invert: true },
  });

  // Per-tree brightness variation. Greyscale (R=G=B from the same range) keeps
  // the trunk-brown and foliage-green intact while making each tree slightly
  // lighter/darker.
  const tintCloud = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 5, y: ROW },
    inputValues: { min: [0.65, 0.65, 0.65], max: [1.1, 1.1, 1.1], seed: 0.7 },
  });

  // Ground material.
  const groundColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: { color: [0.32, 0.24, 0.16, 1], resolution: 16 },
  });
  const groundMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 1.2 },
    inputValues: { roughness: 0.85, metallic: 0 },
  });
  const terrainEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 1.2 },
  });

  // Trunk: cylinder grows from y=0 upward (base-at-origin convention), so it
  // lands directly on the surface point when scattered.
  const trunkCyl = addNode(g, 'core/cylinder', {
    position: { x: 0, y: ROW * 3 },
    inputValues: { radius: 0.08, height: 0.9, segments: 10 },
  });
  const trunkColor = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { color: [0.32, 0.2, 0.1, 1], resolution: 16 },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3 },
  });

  // Foliage: sphere lifted above the trunk so its bottom overlaps the trunk
  // top a bit (looks more natural than the foliage just sitting on top).
  const foliageSphere = addNode(g, 'core/sphere', {
    position: { x: 0, y: ROW * 5 },
    inputValues: { radius: 0.4, segments: 16, rings: 12 },
  });
  const foliageLift = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 5 },
    inputValues: { translate: [0, 1.05, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const foliageColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 2, y: ROW * 6 },
    inputValues: { color: [0.18, 0.42, 0.14, 1], resolution: 16 },
  });
  const foliageMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 6 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const foliageEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 5 },
  });

  // Two-entity tree scene.
  const treeMerge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 4 },
  });

  // Scatter: per_point_active routes the slope mask. align=false keeps trees
  // upright (gravity-pointing) on slopes; the mask already filters out
  // anything too steep to look natural standing straight up.
  const scatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 6, y: ROW * 2 },
    inputValues: { scale: 1, align: false, seed: 1 },
  });

  const sceneMerge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 1.2 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 8, y: ROW * 1.2 },
  });

  // Edges.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightfield.id, socket: 'texture' });
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: terrainMesh.id, socket: 'heightfield' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: distribute.id, socket: 'geometry' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: slope.id, socket: 'points' });
  addEdge(g, { node: slope.id, socket: 'values' }, { node: slopeMask.id, socket: 'values' });

  addEdge(g, { node: groundColor.id, socket: 'texture' }, { node: groundMat.id, socket: 'basecolor' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: terrainEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: terrainEntity.id, socket: 'material' });

  addEdge(g, { node: trunkCyl.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: trunkColor.id, socket: 'texture' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  addEdge(g, { node: foliageSphere.id, socket: 'geometry' }, { node: foliageLift.id, socket: 'geometry' });
  addEdge(g, { node: foliageLift.id, socket: 'geometry' }, { node: foliageEntity.id, socket: 'geometry' });
  addEdge(g, { node: foliageColor.id, socket: 'texture' }, { node: foliageMat.id, socket: 'basecolor' });
  addEdge(g, { node: foliageMat.id, socket: 'material' }, { node: foliageEntity.id, socket: 'material' });

  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'a' });
  addEdge(g, { node: foliageEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'b' });

  addEdge(g, { node: distribute.id, socket: 'points' }, { node: scatter.id, socket: 'points' });
  addEdge(g, { node: treeMerge.id, socket: 'scene' }, { node: scatter.id, socket: 'instance' });
  addEdge(g, { node: slopeMask.id, socket: 'mask' }, { node: scatter.id, socket: 'per_point_active' });
  addEdge(g, { node: distribute.id, socket: 'points' }, { node: tintCloud.id, socket: 'points' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: scatter.id, socket: 'per_point_tint' });

  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'a' });
  addEdge(g, { node: scatter.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'b' });
  addEdge(g, { node: sceneMerge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id };
}
