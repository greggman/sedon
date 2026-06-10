import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildApartmentBuildingSubgraph,
  buildOfficeBuildingSubgraph,
  buildShopBuildingSubgraph,
  buildTowerBuildingSubgraph,
} from './city-buildings.js';

// Throwaway preview for the four building subgraphs. One of each
// lined up so the skyline reads as a tower → office → apartment →
// shop step-down on an asphalt plane.
//
//   ┌──┐
//   │  │ tower (~55m)
//   │  │     ┌──┐
//   │  │     │  │ office (~30m)
//   │  │     │  │      ┌──┐
//   │  │     │  │      │  │ apartment (~20m)
//   │  │     │  │      │  │     ┌─┐
//   │  │     │  │      │  │     │ │ shop (~8m)
//   └──┘     └──┘      └──┘     └─┘
//
// Chunk 4 replaces this with the real 5×5 city scene.
export function createCityBuildingsPreviewDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const tower = buildTowerBuildingSubgraph();
  const office = buildOfficeBuildingSubgraph();
  const apartment = buildApartmentBuildingSubgraph();
  const shop = buildShopBuildingSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // Asphalt-grey ground plane wide enough to contain the four
  // buildings at the chosen spacing.
  const plane = addNode(g, 'geom/plane', {
    position: { x: 0, y: 0 },
    inputValues: { size: [200, 100], divisions: [1, 1] },
  });
  const groundMat = addNode(g, 'material/pbr', {
    position: { x: COL, y: 0 },
    inputValues: { basecolor: [0.22, 0.22, 0.24, 1], roughness: 0.85, metallic: 0 },
  });
  const groundEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 2, y: 0 },
  });

  // One instance each, spaced ~35m apart so footprints don't overlap
  // (the office and tower are ~25m wide).
  const placements: { sg: SubgraphDef; tx: number }[] = [
    { sg: tower,     tx: -52 },
    { sg: office,    tx: -17 },
    { sg: apartment, tx:  18 },
    { sg: shop,      tx:  43 },
  ];

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 3, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
      { name: 'scene_4', type: 'Scene', optional: true },
    ],
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: ROW * 2 },
  });

  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: groundEnt.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: groundEnt.id, socket: 'material' });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });

  placements.forEach((p, i) => {
    const wrap = addNode(g, `subgraph/${p.sg.id}`, {
      position: { x: 0, y: ROW * (2 + i) },
    });
    const lift = addNode(g, 'scene/transform', {
      position: { x: COL, y: ROW * (2 + i) },
      inputValues: { translate: [p.tx, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
    addEdge(g, { node: wrap.id, socket: 'scene' }, { node: lift.id, socket: 'scene' });
    addEdge(g, { node: lift.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i + 1}` });
  });

  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [tower, office, apartment, shop],
    cameras: {
      // Orbit looking at the row from in front, slightly above. The
      // tall tower (55m) sets the camera distance — about 110m back
      // so the full skyline fits.
      main: {
        yaw: 0.15,
        pitch: 0.18,
        distance: 110,
        target: [-5, 18, 0],
      },
    },
  };
}
