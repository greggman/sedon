import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';

// City demo: a 12×12 grid of building-shaped scaled cubes on a flat asphalt
// plane, each with random width/height/depth and a random color tint. The
// cube's basecolor is a grid texture (windows-on-walls), so per-point scale
// stretches windows differently per face — taller buildings get taller
// vertical-rectangle windows on their sides, which reads as "skyscraper."
//
// Same instancing/tint machinery as the forest demo, just on a grid layout
// with cube buildings instead of cylinder-trunk-plus-sphere-foliage trees.
// Renders as 2 draw calls (1 ground + 1 buildings batch) regardless of N.
export function createCityDemo(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const COL = 280;
  const ROW = 180;

  // Ground plane.
  const plane = addNode(g, 'core/plane', {
    position: { x: 0, y: 0 },
    inputValues: { size: [24, 24], divisions: [1, 1] },
  });
  const groundMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      basecolor: [0.13, 0.13, 0.15, 1],
      roughness: 0.92,
      metallic: 0,
    },
  });
  const groundEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: ROW * 0.6 },
  });

  // Grid placement of points → per-building variation clouds.
  const grid = addNode(g, 'core/grid-distribute', {
    position: { x: COL, y: 0 },
    inputValues: { cols: 12, rows: 12, spacing: 2, jitter: 0.15, seed: 0.4 },
  });
  // Per-building footprint (X, Z) and height (Y). Heights span 1.5..5.5
  // so a few buildings tower while most stay ~3 units tall.
  const scaleCloud = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 2, y: 0 },
    inputValues: { min: [0.7, 1.5, 0.7], max: [1.4, 5.5, 1.4], seed: 0.6 },
  });
  // Mostly-grey tint with slight color variation; multiplies into the warm
  // wall color so each building reads as a slightly different material.
  const tintCloud = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL * 2, y: ROW },
    inputValues: { min: [0.55, 0.55, 0.55], max: [1.05, 1.0, 0.95], seed: 0.9 },
  });

  // Building geometry: unit cube lifted so its base sits on Y=0. Then
  // per-point scale grows it upward (height = scale.y), keeping the base
  // glued to the ground.
  const cube = addNode(g, 'core/cube', {
    position: { x: 0, y: ROW * 3 },
    inputValues: { size: 1 },
  });
  const lift = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { translate: [0, 0.5, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Window-grid texture: bg = dark window glass, fg = warm wall, thick lines.
  const windows = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 4.5 },
    inputValues: {
      fg: [0.85, 0.78, 0.65, 1],
      bg: [0.16, 0.2, 0.28, 1],
      divisions: [4, 6],
      line_width: 0.15,
      resolution: 256,
    },
  });
  const buildingMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 4.5 },
    inputValues: { roughness: 0.55, metallic: 0.05 },
  });
  const buildingEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3.5 },
  });

  const scatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { scale: 1, align: false, seed: 0.2 },
  });
  const sceneMerge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 1 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 6, y: ROW * 1 },
  });

  // Edges.
  // Ground.
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: groundEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: groundEntity.id, socket: 'material' });

  // Building geometry.
  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: buildingEntity.id, socket: 'geometry' });
  addEdge(g, { node: windows.id, socket: 'texture' }, { node: buildingMat.id, socket: 'basecolor' });
  addEdge(g, { node: buildingMat.id, socket: 'material' }, { node: buildingEntity.id, socket: 'material' });

  // Distribution + per-point clouds.
  addEdge(g, { node: grid.id, socket: 'points' }, { node: scaleCloud.id, socket: 'points' });
  addEdge(g, { node: grid.id, socket: 'points' }, { node: tintCloud.id, socket: 'points' });

  // Scatter buildings.
  addEdge(g, { node: grid.id, socket: 'points' }, { node: scatter.id, socket: 'points' });
  addEdge(g, { node: buildingEntity.id, socket: 'scene' }, { node: scatter.id, socket: 'instance' });
  addEdge(g, { node: scaleCloud.id, socket: 'values' }, { node: scatter.id, socket: 'per_point_scale' });
  addEdge(g, { node: tintCloud.id, socket: 'values' }, { node: scatter.id, socket: 'per_point_tint' });

  // Final.
  addEdge(g, { node: groundEntity.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'scene_0' });
  addEdge(g, { node: scatter.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'scene_1' });
  addEdge(g, { node: sceneMerge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id };
}
