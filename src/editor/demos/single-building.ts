import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildParametricOfficeBuildingSubgraph,
} from './city-buildings.js';
import {
  buildFireEscapeAssembledSubgraph,
  buildFireEscapeBottomModuleSubgraph,
  buildFireEscapeFloorModuleSubgraph,
  buildFireEscapeTopModuleSubgraph,
} from './city-fire-escape.js';
import { buildHvacUnitSubgraph, buildWaterTankSubgraph } from './city-rooftop.js';
import { buildAwningSubgraph } from './city-storefront.js';
import { buildWallAcUnitSubgraph } from './city-wall-ac.js';

// Single-building development scene. Just ONE parametric office at
// origin so per-asset placement (rooftop fittings, storefront awnings,
// wall AC, fire escape) can be inspected up close without the 138-lot
// city's distance / pathing noise. This is the test bed for any new
// procedural-building module: drop it into the parametric office
// graph and load this demo for a 30-second iteration loop.
//
// Includes a wider-than-needed sidewalk on the −X side so storefront
// awnings have a "street" to face. No road network, no other
// buildings, no organic block subdivision — just the building + its
// own fittings + the ground.
export function createSingleBuildingDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  // All the building-internal subgraphs the parametric office wires
  // wrappers to. They have to be in the project's subgraphs list so
  // each `subgraph/<id>` reference resolves at eval time.
  const parametricOffice = buildParametricOfficeBuildingSubgraph();
  const hvacUnit = buildHvacUnitSubgraph();
  const waterTank = buildWaterTankSubgraph();
  const awning = buildAwningSubgraph();
  const wallAc = buildWallAcUnitSubgraph();
  const fireFloor = buildFireEscapeFloorModuleSubgraph();
  const fireBottom = buildFireEscapeBottomModuleSubgraph();
  const fireTop = buildFireEscapeTopModuleSubgraph();
  const fireEscape = buildFireEscapeAssembledSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // ── Ground plane (asphalt grey). Big enough to extend past the
  // building's footprint by ~10 m on each side so it reads as a city
  // block, not a floating slab.
  const plane = addNode(g, 'core/plane', {
    position: { x: 0, y: 0 },
    inputValues: { size: [80, 80], divisions: [1, 1] },
  });
  const groundMat = addNode(g, 'core/material', {
    position: { x: COL, y: 0 },
    inputValues: { basecolor: [0.18, 0.18, 0.19, 1], roughness: 0.95, metallic: 0 },
  });
  const groundEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: 0 },
  });
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: groundEnt.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: groundEnt.id, socket: 'material' });

  // ── The single parametric office at origin. Same defaults as a
  // typical city lot.
  // fire_escape_threshold = -1 forces this single building to render
  // a fire escape (vs the city's default 0.4 which gives ~60% per
  // random pick). The dev demo is for inspecting placement so every
  // visit needs the asset present.
  const officeWrap = addNode(g, `subgraph/${parametricOffice.id}`, {
    position: { x: 0, y: ROW * 2 },
    inputValues: { width: 22, depth: 22, num_floors: 7, fire_escape_threshold: -1 },
  });

  // ── Merge ground + office into the scene.
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3, y: ROW * 1 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: officeWrap.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });

  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: ROW * 1 },
    inputValues: {
      light_direction: [0.4, 0.85, 0.3],
      light_intensity: 2.5,
      ambient_intensity: 1.4,
      fog_density: 0.0004,
    },
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [
      parametricOffice,
      hvacUnit, waterTank, awning, wallAc,
      fireFloor, fireBottom, fireTop, fireEscape,
    ],
    cameras: {
      // Framed so the whole building fits and the fire-escape side
      // wall (+Z face) is visible from the camera's right. Distance
      // ~40 m back, pitch 0.3 rad above horizontal.
      main: {
        yaw: 0.4,
        pitch: 0.25,
        distance: 50,
        target: [0, 14, 0],
      },
    },
  };
}
