import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import { buildCabinetCellSubgraph } from './cabinet-cell-subgraph.js';

// `iter/for-each-point` test scene. A 4×4 grid of cabinet boxes, each
// placed by a private BRIDGE subgraph that maps per-iteration context
// (position, index) and per-cell broadcast values (size, material)
// onto the `cabinet-cell` body subgraph's regular inputs.
//
// Wire flow on the main canvas:
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
// Inside the for-each-point's owned bridge subgraph:
//
//   iteration-input.position  ──→ cabinet-cell.position
//   subgraph-input.size       ──→ cabinet-cell.size
//   subgraph-input.material   ──→ cabinet-cell.material
//   cabinet-cell.scene        ──→ iteration-output.scene
//
// What this exercises end-to-end:
//   • The for-each-point's outer-input mirroring (`size` is
//     Vec3Cloud-typed → per-cell deref; `material` is broadcast).
//   • Bridge graph composition — iteration-input.position is wired
//     to body.position by NAME, demonstrating the polymorphism
//     contract (body is generic; bridge does the mapping).
//   • Multi-source Scene merge.
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
  const grid = addNode(g, 'points/grid', {
    position: { x: 0, y: ROW },
    inputValues: { cols: 4, rows: 4, spacing: 0.55, jitter: 0, seed: 0 },
  });

  // Per-cell size: each cabinet gets a slightly different aspect
  // ratio so the grid reads as a row of differently-proportioned
  // units rather than a clone field.
  const sizes = addNode(g, 'cloud/random-vec3', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { min: [0.3, 0.4, 0.2], max: [0.5, 0.8, 0.4], seed: 5 },
  });

  // Wood material — broadcast to every cabinet. Flat basecolor →
  // inline colour default, no solid-color node needed.
  const woodMaterial = addNode(g, 'material/pbr', {
    position: { x: COL, y: 0 },
    inputValues: {
      basecolor: [0.55, 0.36, 0.20, 1.0],
      roughness: 0.7,
      metallic: 0,
    },
  });

  // Stable for-each-point id so the bridge id (`bridge-<forEachId>`)
  // stays deterministic for this demo. extras are pre-populated so
  // the demo loads with the bridge already wired without going
  // through the editor's drag-drop attach action.
  const forEachId = 'fep-cabinets';
  const bridgeId = `bridge-${forEachId}`;
  const forEach = addNode(g, 'iter/for-each-point', {
    id: forEachId,
    position: { x: COL * 2, y: ROW },
    inputValues: { __bridgeId: bridgeId },
    extraInputs: [
      { name: 'size', type: 'Vec3Cloud', optional: true },
      { name: 'material', type: 'Material', optional: true },
    ],
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });

  // Ground plane: a flat 4×4m board tinted grey-green so the cabinets
  // have something to stand on.
  const ground = addNode(g, 'geom/plane', {
    position: { x: 0, y: ROW * 2.5 },
    inputValues: { size: [4, 4], divisions: [1, 1] },
  });
  const groundMaterial = addNode(g, 'material/pbr', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      basecolor: [0.32, 0.38, 0.30, 1.0],
      roughness: 0.95,
      metallic: 0,
    },
  });
  const groundEntity = addNode(g, 'scene/entity', {
    position: { x: COL * 2, y: ROW * 2.7 },
  });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 3, y: ROW * 1.7 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  const output = addNode(g, 'core/output', { position: { x: COL * 4, y: ROW * 1.7 } });

  addEdge(g, { node: grid.id, socket: 'points' }, { node: forEach.id, socket: 'points' });
  addEdge(g, { node: grid.id, socket: 'points' }, { node: sizes.id, socket: 'points' });
  addEdge(g, { node: sizes.id, socket: 'values' }, { node: forEach.id, socket: 'size' });

  addEdge(g, { node: woodMaterial.id, socket: 'material' }, { node: forEach.id, socket: 'material' });

  addEdge(g, { node: ground.id, socket: 'geometry' }, { node: groundEntity.id, socket: 'geometry' });
  addEdge(g, { node: groundMaterial.id, socket: 'material' }, { node: groundEntity.id, socket: 'material' });

  addEdge(g, { node: forEach.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: groundEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [buildCabinetCellSubgraph(), buildCabinetBridgeSubgraph(forEachId)],
    cameras: { main: { yaw: 0.6, pitch: 0.55, distance: 4.5, target: [0, 0.3, 0] } },
  };
}

// The for-each-point's private bridge subgraph: maps per-iteration
// context (position, index) and broadcast inputs (size, material)
// onto the cabinet-cell body's named inputs. Authored by hand here
// so the demo loads end-to-end without going through the editor's
// `attachIterationBody` action — same shape that action produces.
function buildCabinetBridgeSubgraph(forEachId: string): SubgraphDef {
  const id = `bridge-${forEachId}`;
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputBoundary = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: 0 },
  });
  const iterInputBoundary = addNode(g, `iteration-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const iterOutputBoundary = addNode(g, `iteration-output/${id}`, {
    position: { x: COL * 3, y: ROW / 2 },
  });
  const body = addNode(g, 'subgraph/cabinet-cell', {
    position: { x: COL * 1.5, y: ROW / 2 },
  });

  // Iteration context → body input by name match.
  addEdge(g, { node: iterInputBoundary.id, socket: 'position' }, { node: body.id, socket: 'position' });
  // Broadcast inputs the for-each-point exposes on its outer surface.
  addEdge(g, { node: inputBoundary.id, socket: 'size' }, { node: body.id, socket: 'size' });
  addEdge(g, { node: inputBoundary.id, socket: 'material' }, { node: body.id, socket: 'material' });
  // Body's scene output → bridge's iteration-output, which the
  // for-each-point gathers + merges across iterations.
  addEdge(g, { node: body.id, socket: 'scene' }, { node: iterOutputBoundary.id, socket: 'scene' });

  return {
    id,
    label: 'for-each-point body (cabinet-cell)',
    category: 'Subgraphs',
    inputs: [
      { name: 'size', type: 'Vec3', optional: true },
      { name: 'material', type: 'Material', optional: true },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputBoundary.id,
    outputNodeId: iterOutputBoundary.id,
    owner: { kind: 'iteration-bridge', nodeId: forEachId },
    iterationKind: 'iter/for-each-point',
  };
}
