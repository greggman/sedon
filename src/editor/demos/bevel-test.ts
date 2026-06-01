import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';

// MINIMAL diagnostic: cube → bevel (passthrough — no selection on the
// input) → entity. With no selection mask the bevel returns the input
// mesh unchanged (line 60 of bevel.ts). If THIS still renders broken,
// the bevel node's mere presence in the chain (its evaluate, its
// upload-to-GPU, the GeometryValue it returns) is enough to break the
// shaded preview.
export function createBevelTestDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const cube = addNode(g, 'core/cube', {
    id: 'cube',
    position: { x: 0, y: 0 },
    inputValues: { size: 1 },
  });
  const select = addNode(g, 'core/select-by-angle', {
    id: 'select',
    position: { x: COL, y: 0 },
    inputValues: { threshold: 30 },
  });
  const bevel = addNode(g, 'core/bevel', {
    id: 'bevel',
    position: { x: COL * 2, y: 0 },
    inputValues: { width: 0.12, segments: 1 },
  });
  const normals = addNode(g, 'core/compute-normals', {
    id: 'normals',
    position: { x: COL * 3, y: 0 },
    inputValues: { cusp_angle: 30 },
  });
  const material = addNode(g, 'core/material', {
    id: 'material',
    position: { x: COL * 2, y: ROW * 2 },
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

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: select.id, socket: 'geometry' });
  addEdge(g, { node: select.id, socket: 'geometry' }, { node: bevel.id, socket: 'geometry' });
  addEdge(g, { node: bevel.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  void normals;
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [],
    cameras: { main: { yaw: 0.7, pitch: 0.4, distance: 3.5, target: [0, 0, 0] } },
  };
}
