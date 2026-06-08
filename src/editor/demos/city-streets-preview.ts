import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildBlockSidewalkSubgraph,
  buildIntersectionSubgraph,
  buildStreetSegmentLongSubgraph,
  buildStreetSegmentShortSubgraph,
} from './city-streets.js';

// Throwaway preview: a 2×2 mini-city layout that places the four
// block sidewalks (with no buildings yet), four street segments
// between them (2 long + 2 short), and a single intersection at
// the crossing. Used to verify that the dimensions match up — if
// the intersection's edges align with the street-segment ends, the
// math in city-streets.ts is right, and chunk 4 can tile this
// pattern in a 5×5 grid.
//
// Layout (top-down, +X right, +Z forward):
//
//   ┌────────┐        ┌────────┐
//   │ block  │        │ block  │
//   │  NW    │  long  │  NE    │
//   │ 100x   │ street │ 100x   │
//   │  200   │ (Z)    │  200   │
//   └────────┘        └────────┘
//        short street (X)  intersection  short street (X)
//   ┌────────┐        ┌────────┐
//   │ block  │        │ block  │
//   │  SW    │  long  │  SE    │
//   │        │ street │        │
//   │        │ (Z)    │        │
//   └────────┘        └────────┘
export function createCityStreetsPreviewDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const longStreet = buildStreetSegmentLongSubgraph();
  const shortStreet = buildStreetSegmentShortSubgraph();
  const intersection = buildIntersectionSubgraph();
  const blockSidewalk = buildBlockSidewalkSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // Block-centre coordinates. Blocks are 100w × 200d, streets are
  // 18 wide. So block centres in a 2×2 are at ±(100/2 + 18/2) along
  // X and ±(200/2 + 18/2) along Z = ±59 X, ±109 Z.
  const STREET_WIDTH = 18;
  const BLOCK_SHORT = 100;
  const BLOCK_LONG = 200;
  const blockX = (BLOCK_SHORT + STREET_WIDTH) / 2;  // 59
  const blockZ = (BLOCK_LONG + STREET_WIDTH) / 2;   // 109

  // Helper: place a wrapper of subgraph `sg` at (tx, 0, tz) with
  // optional Y rotation (radians). Returns the transform-scene
  // node so callers chain into a scene-merge.
  const placements: { sg: SubgraphDef; tx: number; tz: number; ry: number }[] = [];

  // 4 blocks at the corners.
  placements.push({ sg: blockSidewalk, tx: -blockX, tz:  blockZ, ry: 0 });
  placements.push({ sg: blockSidewalk, tx:  blockX, tz:  blockZ, ry: 0 });
  placements.push({ sg: blockSidewalk, tx: -blockX, tz: -blockZ, ry: 0 });
  placements.push({ sg: blockSidewalk, tx:  blockX, tz: -blockZ, ry: 0 });

  // Two long streets (N-S) running through the centre, one between
  // the west and east column of blocks (at X=0). Length 200m, so one
  // segment for the north half, one for the south half — placed at
  // Z = ±blockZ so they fill the rows.
  placements.push({ sg: longStreet, tx: 0, tz:  blockZ, ry: 0 });
  placements.push({ sg: longStreet, tx: 0, tz: -blockZ, ry: 0 });

  // Two short streets (E-W) running through the centre, between the
  // north and south rows of blocks. Length 100m. Rotated 90° Y so
  // the segment's long axis (Z) becomes X.
  placements.push({ sg: shortStreet, tx: -blockX, tz: 0, ry: Math.PI / 2 });
  placements.push({ sg: shortStreet, tx:  blockX, tz: 0, ry: Math.PI / 2 });

  // One intersection at the centre.
  placements.push({ sg: intersection, tx: 0, tz: 0, ry: 0 });

  // ── Ground plane large enough to back the whole layout. Lifted
  // DOWN by 0.1m so it doesn't z-fight the asphalt at y=0 (and the
  // sidewalks / stripes lifted a hair above that). The 0.1m gap is
  // invisible at the city overview camera distance but bigger than
  // any depth-buffer precision wobble at this scene scale.
  const plane = addNode(g, 'core/plane', {
    position: { x: 0, y: 0 },
    inputValues: { size: [400, 600], divisions: [1, 1] },
  });
  const groundLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 0.5, y: 0 },
    inputValues: { translate: [0, -0.1, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const groundMat = addNode(g, 'core/material', {
    position: { x: COL, y: 0 },
    inputValues: {
      basecolor: [0.30, 0.32, 0.28, 1],  // a hint of green so non-road areas read as ground
      roughness: 0.95, metallic: 0,
    },
  });
  const groundEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: 0 },
  });

  // ── Scene merge with one slot per placement + ground.
  const extraInputs = [{ name: 'scene_0', type: 'Scene' as const, optional: true }];
  for (let i = 0; i < placements.length; i++) {
    extraInputs.push({ name: `scene_${i + 1}`, type: 'Scene' as const, optional: true });
  }
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 2 },
    extraInputs,
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 5, y: ROW * 2 },
  });

  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: groundLift.id, socket: 'geometry' });
  addEdge(g, { node: groundLift.id, socket: 'geometry' }, { node: groundEnt.id, socket: 'geometry' });
  addEdge(g, { node: groundMat.id, socket: 'material' }, { node: groundEnt.id, socket: 'material' });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });

  placements.forEach((p, i) => {
    const wrap = addNode(g, `subgraph/${p.sg.id}`, {
      position: { x: 0, y: ROW * (2 + i * 0.6) },
    });
    const lift = addNode(g, 'core/transform-scene', {
      position: { x: COL, y: ROW * (2 + i * 0.6) },
      inputValues: {
        translate: [p.tx, 0, p.tz],
        rotate: [0, p.ry, 0],
        scale: [1, 1, 1],
      },
    });
    addEdge(g, { node: wrap.id, socket: 'scene' }, { node: lift.id, socket: 'scene' });
    addEdge(g, { node: lift.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i + 1}` });
  });

  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  // Dedupe — same subgraph used in multiple placements, but the
  // returned subgraphs[] needs unique entries.
  const uniqueSubgraphs = [
    longStreet, shortStreet, intersection, blockSidewalk,
  ];

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: uniqueSubgraphs,
    cameras: {
      // High-angle overview looking down so the road grid + sidewalk
      // borders + crosswalks all read at once.
      main: {
        yaw: 0.2,
        pitch: 0.85,
        distance: 360,
        target: [0, 0, 0],
      },
    },
  };
}
