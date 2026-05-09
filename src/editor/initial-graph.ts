import { addEdge, addNode, createGraph, type Graph } from '../core/graph.js';

// The POC graph: Color (fg) + Color (bg) → Grid → Material; Sphere → Output.
// Positions are laid out left-to-right by dependency depth so the read-only view
// is legible without an auto-layout pass.
export function createInitialGraph(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const fg = addNode(g, 'core/color', {
    position: { x: 0, y: 0 },
    inputValues: { value: [0.05, 0.05, 0.1, 1] },
  });
  const bg = addNode(g, 'core/color', {
    position: { x: 0, y: 140 },
    inputValues: { value: [0.95, 0.85, 0.4, 1] },
  });
  const grid = addNode(g, 'core/grid', {
    position: { x: 240, y: 50 },
    inputValues: { divisions: [12, 12], line_width: 0.06 },
  });
  const material = addNode(g, 'core/material', {
    position: { x: 480, y: 50 },
  });
  const sphere = addNode(g, 'core/sphere', {
    position: { x: 240, y: 280 },
    inputValues: { radius: 1, segments: 64, rings: 32 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: 720, y: 165 },
  });

  addEdge(g, { node: fg.id, socket: 'color' }, { node: grid.id, socket: 'fg' });
  addEdge(g, { node: bg.id, socket: 'color' }, { node: grid.id, socket: 'bg' });
  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: output.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: output.id, socket: 'material' });

  return { graph: g, rootNodeId: output.id };
}
