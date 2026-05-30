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
  const heightFloat = addNode(g, 'core/texture-convert', {
    position: { x: COL, y: 0 },
    inputValues: { format: 1 },
  });
  const heightScale = addNode(g, 'core/texture-map-range', {
    position: { x: COL * 1.25, y: 0 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 30, clamp: false },
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

  // A river-shaped path that meanders across the terrain. The
  // authored control points live on a core/point-list (so the user
  // can drag them in the 2D editor with the heightfield as a
  // backdrop); path/spline smooths them into a polyline and
  // path/carve-heightfield cuts the route into the terrain.
  const pathPoints = addNode(g, 'core/point-list', {
    position: { x: COL * 1.55, y: ROW * 1.5 },
    inputValues: {
      world_size: [200, 200],
      points: [
        [-90, 0, -90],
        [-50, 0, -60],
        [-30, 0, 0],
        [10, 0, 20],
        [40, 0, -10],
        [80, 0, 40],
        [90, 0, 90],
      ],
    },
  });
  const pathSpline = addNode(g, 'path/spline', {
    position: { x: COL * 1.7, y: ROW * 1.5 },
    inputValues: { width: 6, samples_per_segment: 16 },
  });
  const pathCarve = addNode(g, 'path/carve-heightfield', {
    position: { x: COL * 1.85, y: 0 },
    inputValues: { worldSize: [200, 200], depth: 8, falloff: 10 },
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
      worldSize: [200, 200],
      chunk_count: [8, 8],
      base_divisions: 32,
      lod_levels: 4,
      lod_distance: 60,
    },
  });
  // Water surface pooled in the carved river bed + low valleys. With
  // heightRange [0,30] and the eroded terrain, water_level=10 floods
  // the carved channel and adjacent low ground while the eroded
  // ridges (~15–30 m) rise above as islands — reads as a coastline.
  const water = addNode(g, 'water/plane', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: {
      water_level: 13.0,
      color: [0.05, 0.25, 0.4, 0.7],
      wave_strength: 0.4,
      wave_scale: 6,
      wave_speed: 1.0,
      roughness: 0.05,
      absorption: 1,
      foam_width: 1.5,
    },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: 0 },
  });

  // === Edges ============================================================
  // Heightfield chain: perlin → texture-convert(rgba16f) → texture-map-range
  // (0..30m metres) → erosion → path/carve → terrain/renderer.
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightFloat.id, socket: 'texture' });
  addEdge(g, { node: heightFloat.id, socket: 'texture' }, { node: heightScale.id, socket: 'texture' });
  addEdge(g, { node: heightScale.id, socket: 'texture' }, { node: erosion.id, socket: 'texture' });
  addEdge(g, { node: erosion.id, socket: 'texture' }, { node: pathCarve.id, socket: 'texture' });
  // Point-list feeds the spline; the eroded heightfield also feeds
  // the point-list as a `preview_texture` backdrop so the user
  // editing the road in the 2D popup sees the terrain underneath
  // and can position the route relative to ridges / valleys.
  addEdge(g, { node: pathPoints.id, socket: 'points' }, { node: pathSpline.id, socket: 'points' });
  addEdge(g, { node: erosion.id, socket: 'texture' }, { node: pathPoints.id, socket: 'preview_texture' });
  addEdge(g, { node: pathSpline.id, socket: 'path' }, { node: pathCarve.id, socket: 'path' });
  addEdge(g, { node: pathCarve.id, socket: 'texture' }, { node: terrainRenderer.id, socket: 'heightTexture' });

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

  // Water takes the terrain renderer's Scene, appends a water entity,
  // and forwards the merged scene straight to the output. The water
  // node now extracts the heightfield (for foam UV) from the
  // incoming scene's terrain field, so no separate heightfield edge.
  addEdge(g, { node: terrainRenderer.id, socket: 'scene' }, { node: water.id, socket: 'scene' });
  addEdge(g, { node: water.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

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
