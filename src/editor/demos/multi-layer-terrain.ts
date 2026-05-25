import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { CameraState } from '../store.js';

// Chunked-LOD terrain sandbox. Same colour-layer setup as the original
// multi-layer test, but rendered via `terrain/renderer` instead of
// `heightfield-to-mesh + scene-entity`. The world is 200×200m (5×
// bigger than the earlier 40×40m demo) and split into 8×8 chunks; the
// renderer picks an LOD per chunk from camera distance, so distant
// chunks coarse out automatically.
//
// Four solid-color layers (red/green/blue/white) blended by an RGBA
// splat let you eyeball that each layer's albedo is sampled correctly
// after the chunk/LOD path lands.
export function createMultiLayerTerrainDemo(): {
  graph: Graph;
  rootNodeId: string;
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 260;
  const ROW = 180;

  // Heightfield from a single perlin, then run hydraulic erosion to
  // carve realistic channels. 200×200m so LOD differences are
  // visible — near chunks ≈ a few metres, far chunks ≈ 100m+ where
  // the coarsest LOD looks fine.
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: [4, 4], octaves: 5, lacunarity: 2, gain: 0.5, seed: 1, resolution: 512 },
  });
  const heightfield = addNode(g, 'core/heightfield', {
    position: { x: COL, y: 0 },
    inputValues: { worldSize: [200, 200], heightRange: [0, 30] },
  });
  const erosion = addNode(g, 'terrain/hydraulic-erosion', {
    position: { x: COL * 1.5, y: 0 },
    inputValues: {
      drops: 60000,
      seed: 1,
      max_lifetime: 40,
      inertia: 0.05,
      capacity: 4,
      deposition: 0.3,
      erosion: 0.3,
      evaporation: 0.01,
      gravity: 4,
      min_slope: 0.01,
      brush_radius: 3,
    },
  });

  // Four solid-color layer albedos (red / green / blue / white).
  const albedo0 = addNode(g, 'core/solid-color', {
    position: { x: 0, y: ROW * 1.5 },
    inputValues: { color: [1.0, 0.2, 0.2, 1], resolution: 64 },
  });
  const albedo1 = addNode(g, 'core/solid-color', {
    position: { x: 0, y: ROW * 2.5 },
    inputValues: { color: [0.2, 1.0, 0.2, 1], resolution: 64 },
  });
  const albedo2 = addNode(g, 'core/solid-color', {
    position: { x: 0, y: ROW * 3.5 },
    inputValues: { color: [0.2, 0.2, 1.0, 1], resolution: 64 },
  });
  const albedo3 = addNode(g, 'core/solid-color', {
    position: { x: 0, y: ROW * 4.5 },
    inputValues: { color: [1.0, 1.0, 1.0, 1], resolution: 64 },
  });
  const layer0 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 1.5 } });
  const layer1 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 2.5 } });
  const layer2 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 3.5 } });
  const layer3 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 4.5 } });

  // Splat with layer-0 dominant + smaller contributions from the rest.
  const splat = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 5.5 },
    inputValues: { color: [0.6, 0.2, 0.15, 0.05], resolution: 32 },
  });

  const material = addNode(g, 'terrain/material', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { tile_scale: [12, 12], metallic: 0, height_blend_sharpness: 4 },
    extraInputs: [
      { name: 'layer_0', type: 'TerrainLayer', optional: true },
      { name: 'layer_1', type: 'TerrainLayer', optional: true },
      { name: 'layer_2', type: 'TerrainLayer', optional: true },
      { name: 'layer_3', type: 'TerrainLayer', optional: true },
    ],
  });

  // Chunked-LOD renderer replaces the old heightfield-to-mesh +
  // scene-entity path. 8×8 chunks, 4 LOD levels. lodDistance 60 means
  // near chunks (~60 m) use LOD 0, then 60→120 m LOD 1, 120→180 m
  // LOD 2, 180m+ LOD 3. With the camera at distance 130 framing the
  // 200 m terrain, all four LODs are exercised across the visible
  // chunks.
  const terrainRenderer = addNode(g, 'terrain/renderer', {
    position: { x: COL * 3, y: 0 },
    inputValues: {
      chunk_count: [8, 8],
      base_divisions: 32,
      lod_levels: 4,
      lod_distance: 60,
    },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: 0 },
  });

  // === Edges ============================================================
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightfield.id, socket: 'texture' });
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: erosion.id, socket: 'heightfield' });
  addEdge(g, { node: erosion.id, socket: 'heightfield' }, { node: terrainRenderer.id, socket: 'heightfield' });

  addEdge(g, { node: albedo0.id, socket: 'texture' }, { node: layer0.id, socket: 'albedo' });
  addEdge(g, { node: albedo1.id, socket: 'texture' }, { node: layer1.id, socket: 'albedo' });
  addEdge(g, { node: albedo2.id, socket: 'texture' }, { node: layer2.id, socket: 'albedo' });
  addEdge(g, { node: albedo3.id, socket: 'texture' }, { node: layer3.id, socket: 'albedo' });

  addEdge(g, { node: layer0.id, socket: 'layer' }, { node: material.id, socket: 'layer_0' });
  addEdge(g, { node: layer1.id, socket: 'layer' }, { node: material.id, socket: 'layer_1' });
  addEdge(g, { node: layer2.id, socket: 'layer' }, { node: material.id, socket: 'layer_2' });
  addEdge(g, { node: layer3.id, socket: 'layer' }, { node: material.id, socket: 'layer_3' });

  addEdge(g, { node: splat.id, socket: 'texture' }, { node: material.id, socket: 'splat' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: terrainRenderer.id, socket: 'material' });
  addEdge(g, { node: terrainRenderer.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Frame the 200m terrain from a moderate elevation/distance so the
  // camera sits roughly above the centre but with chunks at a range of
  // distances — exercises multiple LODs.
  const cameras: Record<string, CameraState> = {
    main: { yaw: 0.4, pitch: 0.45, distance: 130, target: [0, 12, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    cameras,
  };
}
