import { addEdge, addNode, createGraph, type Graph } from '../core/graph.js';

// Phase-2-style starter graph: Grid texture with inline fg/bg colors → Material →
// SceneEntity ← Sphere → Output. The Output now consumes a Scene; SceneEntity
// promotes the (geometry, material) pair into a one-entity Scene.
export function createInitialGraph(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const grid = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.05, 0.05, 0.1, 1],
      bg: [0.95, 0.85, 0.4, 1],
      divisions: [12, 12],
      line_width: 0.06,
    },
  });
  const material = addNode(g, 'core/material', {
    position: { x: 280, y: 0 },
  });
  const sphere = addNode(g, 'core/sphere', {
    position: { x: 0, y: 280 },
    inputValues: { radius: 1, segments: 64, rings: 32 },
  });
  const sceneEntity = addNode(g, 'core/scene-entity', {
    position: { x: 560, y: 140 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: 800, y: 140 },
  });

  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: sceneEntity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: sceneEntity.id, socket: 'material' });
  addEdge(g, { node: sceneEntity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id };
}
