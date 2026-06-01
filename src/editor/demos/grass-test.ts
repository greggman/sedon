import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { CameraState } from '../store.js';

// Showcase for the camera-relative GPU grass system. A small hilly
// heightfield with a single grass field demonstrating the full
// authoring workflow:
//   • density map (perlin) → patchy coverage, not a uniform lawn
//   • type map (low-freq perlin) → two grass TYPES selected per area
//     (lush green in some patches, dry golden in others), proving the
//     multi-card texture-2d-array path
//   • maxSlope → grass thins on the steeper hillsides
// Blades are placed every frame by the renderer's compute pass around
// the camera (src/render/grass.ts); this graph only produces the maps
// + tuning. Blade art comes from core/grass-blades (alpha silhouette).
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
  const heightFloat = addNode(g, 'core/texture-convert', {
    position: { x: COL, y: 0 },
    inputValues: { format: 1 },
  });
  const heightScale = addNode(g, 'core/texture-map-range', {
    position: { x: COL * 1.6, y: 0 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 6, clamp: false },
  });
  const terrainMesh = addNode(g, 'core/texture-to-heightfield-mesh', {
    position: { x: COL * 2.2, y: 0 },
    inputValues: { worldSize: [60, 60], divisions: [128, 128] },
  });

  // Flat terrain material (muted soil so the grass reads against it).
  const terrainMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW },
    inputValues: {
      basecolor: [0.22, 0.18, 0.12, 1],
      roughness: 1,
      metallic: 0,
    },
  });
  const terrainEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW },
  });

  // Density: a perlin field so grass grows in patches rather than a
  // uniform lawn (R channel 0..1 drives the keep probability)…
  const densityNoise = addNode(g, 'core/perlin', {
    position: { x: 0, y: ROW * 2 },
    inputValues: { scale: [4, 4], octaves: 3, lacunarity: 2, gain: 0.6, seed: 0.2, resolution: 256 },
  });
  // …with a meandering path carved bare. path-mask defaults to white
  // OFF the path, so multiplying it into the density zeroes coverage on
  // the road. (multiply = blend mode 2, factor 1.)
  const path = addNode(g, 'core/path-mask', {
    position: { x: 0, y: ROW * 2.8 },
    inputValues: { angle: 18, offset: 0.5, width: 0.06, waviness: 0.12, waveScale: 1.5, resolution: 256 },
  });
  const density = addNode(g, 'core/blend', {
    position: { x: COL, y: ROW * 2.4 },
    inputValues: { mode: 2, factor: 1, resolution: 256 },
  });

  // Type map: a LOW-frequency perlin so each type covers broad patches.
  // R channel → floor(r * numTypes) picks the card. With 2 cards: r<0.5
  // → green (type 0), r≥0.5 → golden (type 1).
  const typeNoise = addNode(g, 'core/perlin', {
    position: { x: 0, y: ROW * 4 },
    inputValues: { scale: [1.5, 1.5], octaves: 2, lacunarity: 2, gain: 0.5, seed: 0.9, resolution: 256 },
  });

  // Two blade cards (alpha silhouette). Colour lives in the card; the
  // grass node's tint stays near-white so it doesn't double-tint.
  const cardGreen = addNode(g, 'core/grass-blades', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      bladeCount: 5,
      baseColor: [0.13, 0.3, 0.08, 1],
      tipColor: [0.55, 0.8, 0.32, 1],
      width: 1, lean: 0.18, seed: 3, resolution: 256,
    },
  });
  const cardGold = addNode(g, 'core/grass-blades', {
    position: { x: COL, y: ROW * 5 },
    inputValues: {
      bladeCount: 4,
      baseColor: [0.32, 0.26, 0.06, 1],
      tipColor: [0.78, 0.66, 0.22, 1],
      width: 1.1, lean: 0.28, seed: 8, resolution: 256,
    },
  });

  const grass = addNode(g, 'core/grass', {
    position: { x: COL * 3, y: ROW * 2 },
    // card_1 is a per-instance extra socket (matches the node's
    // extraInputsSpec namePrefix 'card'); card_0 is the static input.
    extraInputs: [{ name: 'card_1', type: 'Texture2D', optional: true }],
    inputValues: {
      worldSize: [60, 60],
      maxDistance: 35,
      spacing: 0.3,
      bladeWidth: 0.22,
      bladeHeight: 0.75,
      densityScale: 1.2,
      maxSlope: 0.6,
      windStrength: 0.12,
      windSpeed: 2.5,
      // Near-white so the cards' authored colours show through; the
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

  // Terrain wiring. Perlin → float-format → 0..6m metres → mesh.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightFloat.id, socket: 'texture' });
  addEdge(g, { node: heightFloat.id, socket: 'texture' }, { node: heightScale.id, socket: 'texture' });
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: terrainMesh.id, socket: 'texture' });
  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: terrainEntity.id, socket: 'geometry' });
  addEdge(g, { node: terrainMat.id, socket: 'material' }, { node: terrainEntity.id, socket: 'material' });

  // Density = patchy noise × path-mask (path carved bare).
  addEdge(g, { node: densityNoise.id, socket: 'texture' }, { node: density.id, socket: 'a' });
  addEdge(g, { node: path.id, socket: 'texture' }, { node: density.id, socket: 'b' });

  // Grass wiring.
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: grass.id, socket: 'heightTexture' });
  addEdge(g, { node: density.id, socket: 'texture' }, { node: grass.id, socket: 'density' });
  addEdge(g, { node: typeNoise.id, socket: 'texture' }, { node: grass.id, socket: 'typeMap' });
  addEdge(g, { node: cardGreen.id, socket: 'texture' }, { node: grass.id, socket: 'card_0' });
  addEdge(g, { node: cardGold.id, socket: 'texture' }, { node: grass.id, socket: 'card_1' });

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
