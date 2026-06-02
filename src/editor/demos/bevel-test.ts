import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';

// Diagnostic scene for `core/bevel` — wraps the docs-sample
// cube → select-by-angle → bevel pipeline in a reusable subgraph,
// then renders it through a blue PBR material so the rounded
// bevel's shading is unambiguous. No `core/compute-normals`
// downstream: the bevel emits real per-face normals (cube face on
// the face polygons, 45° / slerped on the chamfer strips,
// body-diagonal / barycentric-slerped on the corner caps), so the
// shaded preview lights correctly without a downstream smoothing
// pass.
export function createBevelTestDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const cubeNode = addNode(g, 'subgraph/beveled-cube', {
    id: 'cube',
    position: { x: 0, y: 0 },
  });

  const material = addNode(g, 'core/material', {
    id: 'material',
    position: { x: COL, y: ROW * 2 },
    inputValues: {
      basecolor: [0.20, 0.45, 0.85, 1],
      roughness: 0.4,
      metallic: 0,
    },
  });

  const entity = addNode(g, 'core/scene-entity', {
    id: 'entity',
    position: { x: COL * 2, y: ROW },
  });
  const output = addNode(g, 'core/output', {
    id: 'output',
    position: { x: COL * 3, y: ROW },
  });

  addEdge(g, { node: cubeNode.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [buildBeveledCubeSubgraph()],
    cameras: { main: { yaw: 0.7, pitch: 0.4, distance: 3.5, target: [0, 0, 0] } },
  };
}

// "Beveled cube" body subgraph — the canonical bevel pipeline made
// reusable. No inputs (bevel params are baked in so the diagnostic
// scene is reproducible). One output: a Geometry whose vertices
// already carry correct per-face / per-strip / per-cap normals
// from the bevel node itself.
function buildBeveledCubeSubgraph(): SubgraphDef {
  const id = 'beveled-cube';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 4, y: ROW },
  });

  const cube = addNode(g, 'core/cube', {
    position: { x: COL, y: 0 },
    inputValues: { size: 1 },
  });
  const select = addNode(g, 'core/select-by-angle', {
    position: { x: COL * 2, y: 0 },
    inputValues: { threshold: 30 },
  });
  const bevel = addNode(g, 'core/bevel', {
    position: { x: COL * 3, y: 0 },
    inputValues: { width: 0.12, segments: 4 },
  });

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: select.id, socket: 'geometry' });
  addEdge(g, { node: select.id, socket: 'geometry' }, { node: bevel.id, socket: 'geometry' });
  addEdge(g, { node: bevel.id, socket: 'geometry' }, { node: outputNode.id, socket: 'geometry' });

  return {
    id,
    label: 'Beveled cube',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'geometry', type: 'Geometry' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
