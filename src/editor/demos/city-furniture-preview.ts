import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildCarSubgraph,
  buildFireHydrantSubgraph,
  buildLampPostSubgraph,
  buildTrafficSignalSubgraph,
} from './city-furniture.js';

// Throwaway preview demo for the four street-furniture subgraphs.
// Drops one wrapper of each onto a slate-grey "asphalt-ish" plane
// arranged in a row so an overview-camera shot shows everything side
// by side. Used to dial in proportions while building chunks 1-3;
// chunk 4 replaces this with the real 5×5 city scene.
//
// World layout (looking down, +X right, +Z toward camera):
//
//   ●──────●──────●──────●        (4 pieces on a row, ~4m apart)
//   lamp   signal hydrant car
//
// Camera positioned to see the whole row from roughly chest height.
export function createCityFurniturePreviewDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const lamp = buildLampPostSubgraph();
  const signal = buildTrafficSignalSubgraph();
  const hydrant = buildFireHydrantSubgraph();
  const car = buildCarSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // ── Ground plane: 30×15m of asphalt-grey concrete. Large enough
  // for the camera framing not to see the edges at the chosen
  // viewpoint.
  const plane = addNode(g, 'core/plane', {
    position: { x: 0, y: 0 },
    inputValues: { size: [30, 15], divisions: [1, 1] },
  });
  const groundMat = addNode(g, 'core/material', {
    position: { x: COL, y: 0 },
    inputValues: { basecolor: [0.22, 0.22, 0.24, 1], roughness: 0.85, metallic: 0 },
  });
  const groundEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: 0 },
  });

  // ── One instance of each furniture wrapper, placed along X with
  // spacing chosen so each piece is clearly visible. Cars are wider,
  // so they get a wider slot.
  const lampWrap = addNode(g, `subgraph/${lamp.id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const lampLift = addNode(g, 'core/transform-scene', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { translate: [-6, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const signalWrap = addNode(g, `subgraph/${signal.id}`, {
    position: { x: 0, y: ROW * 3 },
  });
  const signalLift = addNode(g, 'core/transform-scene', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { translate: [-2, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const hydrantWrap = addNode(g, `subgraph/${hydrant.id}`, {
    position: { x: 0, y: ROW * 4 },
  });
  const hydrantLift = addNode(g, 'core/transform-scene', {
    position: { x: COL, y: ROW * 4 },
    inputValues: { translate: [2, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const carWrap = addNode(g, `subgraph/${car.id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const carLift = addNode(g, 'core/transform-scene', {
    position: { x: COL, y: ROW * 5 },
    inputValues: { translate: [6, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // ── Scene merge: ground + four pieces.
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3, y: ROW * 2.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
      { name: 'scene_4', type: 'Scene', optional: true },
    ],
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: ROW * 2.5 },
  });

  // Edges.
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: groundEnt.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: groundEnt.id, socket: 'material' });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });

  addEdge(g, { node: lampWrap.id, socket: 'scene' }, { node: lampLift.id, socket: 'scene' });
  addEdge(g, { node: lampLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });

  addEdge(g, { node: signalWrap.id, socket: 'scene' }, { node: signalLift.id, socket: 'scene' });
  addEdge(g, { node: signalLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });

  addEdge(g, { node: hydrantWrap.id, socket: 'scene' }, { node: hydrantLift.id, socket: 'scene' });
  addEdge(g, { node: hydrantLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_3' });

  addEdge(g, { node: carWrap.id, socket: 'scene' }, { node: carLift.id, socket: 'scene' });
  addEdge(g, { node: carLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_4' });

  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [lamp, signal, hydrant, car],
    cameras: {
      // Orbit camera looking at the centre of the row from in front
      // and slightly above. Distance picked so all four pieces fit
      // comfortably in the default-FOV viewport.
      main: {
        yaw: 0,
        pitch: 0.35,
        distance: 16,
        target: [0, 1.5, 0],
      },
    },
  };
}
