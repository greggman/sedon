import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { CameraState } from '../store.js';

// Minimal reflection test scene: pink cube sitting on a flat water
// mirror. Designed to mirror cube.html's Three.js reference so we can
// eyeball the planar reflection in isolation, with no terrain or
// other scene noise. Useful when debugging "is the reflection actually
// in the right place" — far simpler than the multi-layer-terrain demo.
//
// Geometry:
//   • Water at y = 0, plane size 12 × 12 (matches cube.html's mirror).
//   • Pink cube size 2 sitting on the water (center y = 1, bottom on
//     the surface, half above and reflected half below).
//   • Camera at (3, 5, 10) looking at (0, 1.2, 0) — same as cube.html.
//
// Water configured for a clean mirror: wave_strength = 0,
// foam_width = 0, so the reflection isn't distorted or hidden by
// surf. The reflection should clearly show the cube's underside
// reflected in the water plane, with the rest of the water showing
// the sky-clear reflection background.
export function createCubeOnWaterDemo(): {
  graph: Graph;
  rootNodeId: string;
  cameras: Record<string, CameraState>;
} {
  const g = createGraph();
  const COL = 220;
  const ROW = 160;

  // Pink texture → PBR material.
  const pinkColor = addNode(g, 'core/solid-color', {
    position: { x: 0, y: 0 },
    inputValues: { color: [1.0, 0.42, 0.71, 1.0], resolution: 32 },
  });
  const cubeMaterial = addNode(g, 'core/material', {
    position: { x: COL, y: 0 },
    inputValues: { roughness: 0.4, metallic: 0 },
  });

  // Cube geometry, translated so its bottom sits on the water at y=0.
  const cubeGeom = addNode(g, 'core/cube', {
    position: { x: 0, y: ROW },
    inputValues: { size: 2 },
  });
  const cubeXform = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW },
    inputValues: { translate: [0, 1, 0] },
  });
  const cubeEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: ROW / 2 },
  });

  // Water plane: flat (no waves, no foam), matches cube.html's 12 × 12
  // mirror sized to extent 1× of world_size.
  const water = addNode(g, 'water/plane', {
    position: { x: COL * 3, y: ROW / 2 },
    inputValues: {
      water_level: 0,
      wave_strength: 0,
      foam_width: 0,
      world_size: [12, 12],
      extent_scale: 1,
      color: [0.1, 0.35, 0.45, 0.9],
    },
  });

  const output = addNode(g, 'core/output', { position: { x: COL * 4, y: ROW / 2 } });

  addEdge(g, { node: pinkColor.id, socket: 'texture' }, { node: cubeMaterial.id, socket: 'basecolor' });
  addEdge(g, { node: cubeGeom.id, socket: 'geometry' }, { node: cubeXform.id, socket: 'geometry' });
  addEdge(g, { node: cubeXform.id, socket: 'geometry' }, { node: cubeEntity.id, socket: 'geometry' });
  addEdge(g, { node: cubeMaterial.id, socket: 'material' }, { node: cubeEntity.id, socket: 'material' });
  addEdge(g, { node: cubeEntity.id, socket: 'scene' }, { node: water.id, socket: 'scene' });
  addEdge(g, { node: water.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Camera (3, 5, 10) → target (0, 1.2, 0). In orbit form:
  //   offset = (3, 3.8, 10), distance = ‖offset‖ ≈ 11.11,
  //   yaw = atan2(3, 10) ≈ 0.291 rad,
  //   pitch = asin(3.8 / 11.11) ≈ 0.354 rad.
  return {
    graph: g,
    rootNodeId: output.id,
    cameras: { main: { yaw: 0.291, pitch: 0.354, distance: 11.11, target: [0, 1.2, 0] } },
  };
}
