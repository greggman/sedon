import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import { buildCabinetCellSubgraph } from './cabinet-cell-subgraph.js';

// `core/for-each-point` test scene. A 4×4 grid of cabinet boxes laid
// out by `core/grid-distribute`, each one a per-cell-sized cube
// produced by the `cabinet-cell` subgraph body. Per-cell sizes come
// from `core/random-vec3-cloud` keyed off the same point cloud — wire
// flow is:
//
//   grid-distribute ──┬─→ for-each-point.points
//                     └─→ random-vec3-cloud.points
//   random-vec3-cloud ──→ for-each-point.size  (Vec3Cloud, per-cell)
//   solid-color → material ──→ for-each-point.material  (broadcast)
//
//   for-each-point.scene ─┐
//                         ├─→ scene-merge → output
//   ground.scene ─────────┘
//
// Things this exercises end-to-end:
//   • The body subgraph's `__position` (auto-fed from the cloud) and
//     `size` (Vec3 → Vec3Cloud broadcast, derefs per iteration).
//   • Broadcast of a single Material to every iteration.
//   • A second scene (ground plane) merged with the for-each output.
//
// To play with: bump `cols` or `rows` on the grid-distribute and watch
// cabinets auto-multiply. Tweak the random-vec3-cloud's `min` / `max`
// to vary the per-cell aspect ratios. Drop a different subgraph onto
// the for-each-point (from the Assets panel) to swap the body — same
// grid, different stamped geometry.
export function createForEachPointDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  // Per-cell positions: 4×4 grid on the XZ plane, 0.55m apart so the
  // default 0.4×0.6×0.3 cells leave a small gap. Spacing × cols-1
  // ≈ 1.65m total extent — comfortably inside the ground plane.
  const grid = addNode(g, 'core/grid-distribute', {
    position: { x: 0, y: ROW },
    inputValues: { cols: 4, rows: 4, spacing: 0.55, jitter: 0, seed: 0 },
  });

  // Per-cell size: each cabinet gets a slightly different aspect ratio
  // so the grid reads as a row of differently-proportioned units
  // rather than a clone field. min/max chosen so cells stay readable
  // at the 0.55m spacing.
  const sizes = addNode(g, 'core/random-vec3-cloud', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { min: [0.3, 0.4, 0.2], max: [0.5, 0.8, 0.4], seed: 5 },
  });

  // Wood material — broadcast to every cabinet.
  const woodColor = addNode(g, 'core/solid-color', {
    position: { x: 0, y: 0 },
    inputValues: { color: [0.55, 0.36, 0.20, 1.0], resolution: 32 },
  });
  const woodMaterial = addNode(g, 'core/material', {
    position: { x: COL, y: 0 },
    inputValues: { roughness: 0.7, metallic: 0 },
  });

  // for-each-point: body is the `cabinet-cell` subgraph (`__body`
  // points at its wrapper kind). Its `extraInputs` mirror the body's
  // declared inputs — `size` lifted to Vec3Cloud, `material` broadcast.
  // The `__position` / `__index` body inputs are auto-fed by the
  // evaluator so they don't appear as sockets on the for-each side.
  const forEach = addNode(g, 'core/for-each-point', {
    position: { x: COL * 2, y: ROW },
    inputValues: { __body: 'subgraph/cabinet-cell' },
    extraInputs: [
      { name: 'size', type: 'Vec3Cloud', optional: true },
      { name: 'material', type: 'Material', optional: true },
    ],
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });

  // Ground plane: a flat 4×4m board tinted grey-green so the cabinets
  // have something to stand on. Sits at y=0 (cabinets' bases also at
  // y=0, no z-fighting because the plane is single-sided and the cubes
  // sit ABOVE it).
  const ground = addNode(g, 'core/plane', {
    position: { x: 0, y: ROW * 2.5 },
    inputValues: { size: [4, 4], divisions: [1, 1] },
  });
  const groundColor = addNode(g, 'core/solid-color', {
    position: { x: 0, y: ROW * 3.5 },
    inputValues: { color: [0.32, 0.38, 0.30, 1.0], resolution: 32 },
  });
  const groundMaterial = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });
  const groundEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: ROW * 2.7 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3, y: ROW * 1.7 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  const output = addNode(g, 'core/output', { position: { x: COL * 4, y: ROW * 1.7 } });

  // Grid → for-each.points and also → random-vec3-cloud.points (so the
  // cloud's `count` matches the grid count and indexing stays aligned).
  addEdge(g, { node: grid.id, socket: 'points' }, { node: forEach.id, socket: 'points' });
  addEdge(g, { node: grid.id, socket: 'points' }, { node: sizes.id, socket: 'points' });
  addEdge(g, { node: sizes.id, socket: 'values' }, { node: forEach.id, socket: 'size' });

  // Wood material to for-each (broadcast).
  addEdge(g, { node: woodColor.id, socket: 'texture' }, { node: woodMaterial.id, socket: 'basecolor' });
  addEdge(g, { node: woodMaterial.id, socket: 'material' }, { node: forEach.id, socket: 'material' });

  // Ground chain.
  addEdge(g, { node: groundColor.id, socket: 'texture' }, { node: groundMaterial.id, socket: 'basecolor' });
  addEdge(g, { node: ground.id, socket: 'geometry' }, { node: groundEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMaterial.id, socket: 'material' }, { node: groundEntity.id, socket: 'material' });

  // Merge for-each + ground → output.
  addEdge(g, { node: forEach.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: groundEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [buildCabinetCellSubgraph()],
    // Camera angled down on the grid so all 16 cabinets are visible.
    cameras: { main: { yaw: 0.6, pitch: 0.55, distance: 4.5, target: [0, 0.3, 0] } },
  };
}
