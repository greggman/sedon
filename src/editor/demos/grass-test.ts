import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { CameraState } from '../store.js';

// Minimal showcase for the camera-relative GPU grass system. A small
// hilly heightfield, a flat green terrain material, and a single grass
// field covering it. The grass blades are placed every frame by the
// renderer's compute pass around the camera (see src/render/grass.ts),
// not baked here — this graph only produces the maps + tuning.
//
// v1 card art note: the blade card is a plain solid-colour texture
// (fully opaque), so blades render as solid green cross-quads. Real
// alpha-silhouette blade art is a follow-up; this demo exists to
// exercise + verify the compute/indirect placement, wind, and culling.
export function createGrassTestDemo(): {
  graph: Graph;
  rootNodeId: string;
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // Terrain: 60×60m, gentle relief.
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: [2, 2], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0.7, resolution: 512 },
  });
  const heightfield = addNode(g, 'core/heightfield', {
    position: { x: COL, y: 0 },
    inputValues: { worldSize: [60, 60], heightRange: [0, 6] },
  });
  const terrainMesh = addNode(g, 'core/heightfield-to-mesh', {
    position: { x: COL * 2, y: 0 },
    inputValues: { divisions: [128, 128] },
  });

  // Flat terrain material (muted soil so the grass reads against it).
  const soil = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW },
    inputValues: { color: [0.22, 0.18, 0.12, 1], resolution: 64 },
  });
  const terrainMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW },
    inputValues: { roughness: 1, metallic: 0 },
  });
  const terrainEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW },
  });

  // Density: a perlin field so grass grows in patches rather than a
  // uniform lawn (R channel 0..1 directly drives the keep probability).
  const densityNoise = addNode(g, 'core/perlin', {
    position: { x: 0, y: ROW * 2 },
    inputValues: { scale: [4, 4], octaves: 3, lacunarity: 2, gain: 0.6, seed: 0.2, resolution: 256 },
  });

  // Blade card: procedural alpha-silhouette blades. Colour lives in the
  // card; the grass node's tint is left near-white so it doesn't
  // double-tint (colorVariation still jitters per blade).
  const card = addNode(g, 'core/grass-blades', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      bladeCount: 5,
      baseColor: [0.13, 0.3, 0.08, 1],
      tipColor: [0.55, 0.8, 0.32, 1],
      width: 1,
      lean: 0.18,
      seed: 3,
      resolution: 256,
    },
  });

  const grass = addNode(g, 'core/grass', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: {
      maxDistance: 35,
      spacing: 0.3,
      bladeWidth: 0.22,
      bladeHeight: 0.75,
      densityScale: 1.2,
      maxSlope: 0.7,
      windStrength: 0.12,
      windSpeed: 2.5,
      // Near-white so the card's authored colours show through; the
      // tiny base→tip warm bias + colorVariation add subtle variation.
      baseColor: [0.85, 0.9, 0.8, 1],
      tipColor: [1, 1, 0.95, 1],
      colorVariation: 0.3,
      seed: 1,
    },
  });

  const SM2 = [
    { name: 'scene_0', type: 'Scene', optional: true },
    { name: 'scene_1', type: 'Scene', optional: true },
  ];
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW },
    extraInputs: SM2,
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 5, y: ROW },
    inputValues: { fog_density: 0.012, fog_color: [0.7, 0.78, 0.82, 1] },
  });

  // Terrain wiring.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightfield.id, socket: 'texture' });
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: terrainMesh.id, socket: 'heightfield' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: terrainEntity.id, socket: 'geometry' });
  addEdge(g, { node: soil.id, socket: 'texture' }, { node: terrainMat.id, socket: 'basecolor' });
  addEdge(g, { node: terrainMat.id, socket: 'material' }, { node: terrainEntity.id, socket: 'material' });

  // Grass wiring.
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: grass.id, socket: 'heightfield' });
  addEdge(g, { node: densityNoise.id, socket: 'texture' }, { node: grass.id, socket: 'density' });
  addEdge(g, { node: card.id, socket: 'texture' }, { node: grass.id, socket: 'card_0' });

  // Merge terrain + grass → output.
  addEdge(g, { node: terrainEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: grass.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    cameras: {
      main: { yaw: 0.5, pitch: 0.32, distance: 28, target: [0, 3, 0] },
    },
  };
}
