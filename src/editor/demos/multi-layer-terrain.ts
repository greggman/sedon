import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { CameraState } from '../store.js';

// Tiny sandbox for the new multi-layer terrain pipeline. Uses four
// solid-color "layers" (red / green / blue / white) blended by an RGBA
// splat — easy to eyeball that each layer's color appears in the
// rendered terrain. Pair-able with the headless repro
// (scripts/repro-multi-layer-terrain.mjs) for an automated check that
// the pipeline doesn't throw and the rendered canvas has the right
// dominant hues.
//
// Not intended as a "real" terrain demo — it's a smoke test the user
// can also play with. Once we have proper snow/dirt/tundra texture
// subgraphs and a compose-RGBA node, the forest demo gets the same
// upgrade with realistic content.
export function createMultiLayerTerrainDemo(): {
  graph: Graph;
  rootNodeId: string;
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 260;
  const ROW = 180;

  // Heightfield from a single perlin, then run a hydraulic-erosion
  // pass to carve realistic channels + ridges before meshing. The
  // unedited perlin terrain is smooth and uninteresting; ~30k erosion
  // drops give it the iconic eroded look in <100ms.
  const perlin = addNode(g, 'core/perlin', {
    position: { x: 0, y: 0 },
    inputValues: { scale: [2, 2], octaves: 4, lacunarity: 2, gain: 0.5, seed: 1, resolution: 256 },
  });
  const heightfield = addNode(g, 'core/heightfield', {
    position: { x: COL, y: 0 },
    inputValues: { worldSize: [40, 40], heightRange: [0, 8] },
  });
  const erosion = addNode(g, 'terrain/hydraulic-erosion', {
    position: { x: COL * 1.5, y: 0 },
    inputValues: {
      drops: 30000,
      seed: 1,
      max_lifetime: 30,
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
  const terrainMesh = addNode(g, 'core/heightfield-to-mesh', {
    position: { x: COL * 2, y: 0 },
    inputValues: { divisions: [128, 128] },
  });

  // Four solid-color layer albedos. Distinct primaries make it obvious
  // which layer's weight is contributing where in the final image.
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

  // Wrap each albedo in a terrain/layer (other channels default).
  const layer0 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 1.5 } });
  const layer1 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 2.5 } });
  const layer2 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 3.5 } });
  const layer3 = addNode(g, 'terrain/layer', { position: { x: COL, y: ROW * 4.5 } });

  // Splat: one solid color whose RGBA components are the per-layer
  // weights. Equal-ish weights blend a muddy mix; uneven RGBA produces
  // visibly dominant + minor layers. Picking (0.6, 0.2, 0.15, 0.05)
  // means layer 0 (red) dominates with small contributions from the
  // others — and the height-weighted blend factor (default 4) means
  // pixels where layer 0's height channel beats its neighbours will
  // snap to pure red.
  const splat = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 5.5 },
    inputValues: { color: [0.6, 0.2, 0.15, 0.05], resolution: 32 },
  });

  // Variadic layer sockets: pre-declare the 4 slots so the user (and
  // the renderer) sees them without clicking + 4 times.
  const material = addNode(g, 'terrain/material', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { tile_scale: [4, 4], metallic: 0, height_blend_sharpness: 4 },
    extraInputs: [
      { name: 'layer_0', type: 'TerrainLayer', optional: true },
      { name: 'layer_1', type: 'TerrainLayer', optional: true },
      { name: 'layer_2', type: 'TerrainLayer', optional: true },
      { name: 'layer_3', type: 'TerrainLayer', optional: true },
    ],
  });

  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 1.5 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: ROW * 1.5 },
  });

  // === Edges ============================================================
  addEdge(g, { node: perlin.id, socket: 'texture' }, { node: heightfield.id, socket: 'texture' });
  addEdge(g, { node: heightfield.id, socket: 'heightfield' }, { node: erosion.id, socket: 'heightfield' });
  addEdge(g, { node: erosion.id, socket: 'heightfield' }, { node: terrainMesh.id, socket: 'heightfield' });

  addEdge(g, { node: albedo0.id, socket: 'texture' }, { node: layer0.id, socket: 'albedo' });
  addEdge(g, { node: albedo1.id, socket: 'texture' }, { node: layer1.id, socket: 'albedo' });
  addEdge(g, { node: albedo2.id, socket: 'texture' }, { node: layer2.id, socket: 'albedo' });
  addEdge(g, { node: albedo3.id, socket: 'texture' }, { node: layer3.id, socket: 'albedo' });

  addEdge(g, { node: layer0.id, socket: 'layer' }, { node: material.id, socket: 'layer_0' });
  addEdge(g, { node: layer1.id, socket: 'layer' }, { node: material.id, socket: 'layer_1' });
  addEdge(g, { node: layer2.id, socket: 'layer' }, { node: material.id, socket: 'layer_2' });
  addEdge(g, { node: layer3.id, socket: 'layer' }, { node: material.id, socket: 'layer_3' });

  addEdge(g, { node: splat.id, socket: 'texture' }, { node: material.id, socket: 'splat' });

  addEdge(g, { node: terrainMesh.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Frame the 40m terrain from a reasonable elevation.
  const cameras: Record<string, CameraState> = {
    main: { yaw: 0.4, pitch: 0.45, distance: 60, target: [0, 4, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    cameras,
  };
}
