import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import {
  buildApartmentBuildingSubgraph,
  buildOfficeBuildingSubgraph,
  buildShopBuildingSubgraph,
  buildTowerBuildingSubgraph,
} from './city-buildings.js';
import {
  buildCarSubgraph,
  buildFireHydrantSubgraph,
  buildLampPostSubgraph,
  buildTrafficSignalSubgraph,
} from './city-furniture.js';
import {
  buildBlockSidewalkSubgraph,
  buildIntersectionSubgraph,
  buildStreetSegmentLongSubgraph,
  buildStreetSegmentShortSubgraph,
} from './city-streets.js';

// The actual 5×5 city demo. Composes every subgraph from chunks
// 1-3 into one big scene: a grid of 25 blocks (100×200m each)
// separated by 18m streets, with intersections at every crossing,
// 100 buildings (4 per block — one of each type, rotated per block
// so adjacent blocks aren't visually identical), lamp posts on every
// intersection corner, traffic signals at every intersection, fire
// hydrants on most sidewalks, and a sprinkle of stationary cars on
// the streets.
//
// World units are metres throughout. City footprint:
//   • Block grid: 5 × 5
//   • Block centres: ±2 × 118m apart along X (column spacing),
//                    ±2 × 218m apart along Z (row spacing).
//   • Outer extent: ~600m × ~1100m.
//
// All instances are individual wrappers + transform-scene pairs
// rather than a scatter, because the 4 building types per block
// need per-quadrant placement (a uniform scatter would put the
// same building at every grid point). Total node count comes in
// around ~700 — large for a demo but well within the editor's
// per-scene budget, and a single scene-merge at the end means the
// renderer batches every shared-material entity automatically.

const STREET_WIDTH = 18;
const BLOCK_SHORT = 100;
const BLOCK_LONG = 200;
const COLS = 5;
const ROWS = 5;
// Block-to-block centre spacing along each axis. The X axis maps to
// block SHORT (100m) + street, Z to block LONG (200m) + street.
const X_SPACING = BLOCK_SHORT + STREET_WIDTH;  // 118
const Z_SPACING = BLOCK_LONG + STREET_WIDTH;   // 218

// Building positions inside a block (relative to block centre).
// Block interior is roughly 94×194m (3m sidewalk inset on each
// side). Four quadrants of ~47×97m fit one building each with
// room to spare.
const QUAD_OFFSETS: { x: number; z: number }[] = [
  { x: -25, z: -50 },  // NW
  { x:  25, z: -50 },  // NE
  { x: -25, z:  50 },  // SW
  { x:  25, z:  50 },  // SE
];

export function createCityDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  // ── Subgraph definitions ────────────────────────────────────────
  const sidewalk = buildBlockSidewalkSubgraph();
  const longStreet = buildStreetSegmentLongSubgraph();
  const shortStreet = buildStreetSegmentShortSubgraph();
  const intersection = buildIntersectionSubgraph();
  const office = buildOfficeBuildingSubgraph();
  const apartment = buildApartmentBuildingSubgraph();
  const shop = buildShopBuildingSubgraph();
  const tower = buildTowerBuildingSubgraph();
  const lampPost = buildLampPostSubgraph();
  const trafficSignal = buildTrafficSignalSubgraph();
  const fireHydrant = buildFireHydrantSubgraph();
  const car = buildCarSubgraph();

  const buildingDefs = [tower, office, apartment, shop];

  const g = createGraph();
  const COL_X = 280;
  const ROW_Y = 60;

  // Accumulated scene refs. Every wrapper / transform-scene chain
  // produces one Scene that we'll merge at the end. Pushing them
  // all into one list lets the final merge have a deterministic
  // input order.
  const sceneRefs: { nodeId: string; socket: string }[] = [];

  // Layout cursor for the node positions in the editor canvas.
  // Each placed instance gets a fresh column on the canvas so the
  // graph reads top-to-bottom even with hundreds of nodes.
  let layoutY = 0;
  const nextLayoutY = () => {
    layoutY += ROW_Y;
    return layoutY;
  };

  // ── Helper: place one wrapper instance of `sg` at (tx, ty, tz)
  //    with optional Y rotation. Returns the transform-scene output
  //    socket reference.
  const place = (
    sg: SubgraphDef,
    tx: number,
    ty: number,
    tz: number,
    ry = 0,
    extraInputValues?: Record<string, unknown>,
  ): void => {
    const y = nextLayoutY();
    const wrap = addNode(g, `subgraph/${sg.id}`, {
      position: { x: 0, y },
      ...(extraInputValues ? { inputValues: extraInputValues } : {}),
    });
    const lift = addNode(g, 'core/transform-scene', {
      position: { x: COL_X, y },
      inputValues: { translate: [tx, ty, tz], rotate: [0, ry, 0], scale: [1, 1, 1] },
    });
    addEdge(g, { node: wrap.id, socket: 'scene' }, { node: lift.id, socket: 'scene' });
    sceneRefs.push({ nodeId: lift.id, socket: 'scene' });
  };

  // ── Ground plane: a wide grass-coloured plane just below the
  // street layer to avoid z-fighting with sidewalks / stripes.
  // The city footprint is ~600×1100m; the plane extends to 1200×1800
  // so the ground stretches well past the outer blocks (no visible
  // plane edges from any reasonable overview camera angle).
  {
    const y = nextLayoutY();
    const plane = addNode(g, 'core/plane', {
      position: { x: 0, y },
      inputValues: { size: [1200, 1800], divisions: [1, 1] },
    });
    const lift = addNode(g, 'core/transform-geometry', {
      position: { x: COL_X, y },
      inputValues: { translate: [0, -0.1, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
    const mat = addNode(g, 'core/material', {
      position: { x: COL_X, y: y + 30 },
      inputValues: {
        basecolor: [0.30, 0.36, 0.26, 1],  // grass-tinted ground
        roughness: 0.95,
        metallic: 0,
      },
    });
    const ent = addNode(g, 'core/scene-entity', {
      position: { x: COL_X * 2, y },
    });
    addEdge(g, { node: plane.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    sceneRefs.push({ nodeId: ent.id, socket: 'scene' });
  }

  // Block centre at (col, row). col, row ∈ 0..4.
  const blockCentre = (col: number, row: number) => ({
    x: (col - (COLS - 1) / 2) * X_SPACING,
    z: (row - (ROWS - 1) / 2) * Z_SPACING,
  });

  // ── 25 block sidewalks (one per block) ──────────────────────────
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const { x, z } = blockCentre(col, row);
      place(sidewalk, x, 0, z);
    }
  }

  // ── 100 buildings: 4 per block, one in each quadrant. The
  // quadrant→type mapping rotates per block so adjacent blocks
  // don't share the same layout. (col + row) % 4 picks the rotation
  // amount; the building at quadrant q goes to type[(q + rot) % 4].
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const { x, z } = blockCentre(col, row);
      const rot = (col + row) % 4;
      for (let q = 0; q < 4; q++) {
        const type = buildingDefs[(q + rot) % 4]!;
        const off = QUAD_OFFSETS[q]!;
        place(type, x + off.x, 0, z + off.z);
      }
    }
  }

  // ── 20 long-street segments (4 columns × 5 rows). Streets sit
  // between block columns, so X is the midpoint between two
  // adjacent block centres.
  for (let col = 0; col < COLS - 1; col++) {
    const x = (col - (COLS - 1) / 2 + 0.5) * X_SPACING;
    for (let row = 0; row < ROWS; row++) {
      const z = (row - (ROWS - 1) / 2) * Z_SPACING;
      place(longStreet, x, 0, z);
    }
  }

  // ── 20 short-street segments (5 columns × 4 rows). Same idea
  // along Z. Rotated 90° around Y so the segment's internal long
  // axis (Z) becomes X.
  for (let col = 0; col < COLS; col++) {
    const x = (col - (COLS - 1) / 2) * X_SPACING;
    for (let row = 0; row < ROWS - 1; row++) {
      const z = (row - (ROWS - 1) / 2 + 0.5) * Z_SPACING;
      place(shortStreet, x, 0, z, Math.PI / 2);
    }
  }

  // ── 16 intersections at every street crossing.
  for (let col = 0; col < COLS - 1; col++) {
    const x = (col - (COLS - 1) / 2 + 0.5) * X_SPACING;
    for (let row = 0; row < ROWS - 1; row++) {
      const z = (row - (ROWS - 1) / 2 + 0.5) * Z_SPACING;
      place(intersection, x, 0, z);
    }
  }

  // ── 16 traffic signals — one per intersection. Place at the
  // SW corner of the intersection, pole vertical, arm extending
  // NE over the road. (The traffic-signal subgraph's internal
  // arm extends in +X with the head at the far end, so positioning
  // the wrapper at the intersection's SW corner and rotating
  // 0° puts the head over the road's centre.)
  for (let col = 0; col < COLS - 1; col++) {
    const xCenter = (col - (COLS - 1) / 2 + 0.5) * X_SPACING;
    for (let row = 0; row < ROWS - 1; row++) {
      const zCenter = (row - (ROWS - 1) / 2 + 0.5) * Z_SPACING;
      const cornerX = xCenter - STREET_WIDTH / 2 + 0.5;
      const cornerZ = zCenter - STREET_WIDTH / 2 + 0.5;
      place(trafficSignal, cornerX, 0, cornerZ);
    }
  }

  // ── 64 lamp posts: one at each of the 4 corners of every
  // intersection (on the sidewalk side, just inside the block).
  for (let col = 0; col < COLS - 1; col++) {
    const xMid = (col - (COLS - 1) / 2 + 0.5) * X_SPACING;
    for (let row = 0; row < ROWS - 1; row++) {
      const zMid = (row - (ROWS - 1) / 2 + 0.5) * Z_SPACING;
      const dx = STREET_WIDTH / 2 + 1.5;  // 1.5m into the sidewalk
      const dz = STREET_WIDTH / 2 + 1.5;
      place(lampPost, xMid - dx, 0, zMid - dz);
      place(lampPost, xMid + dx, 0, zMid - dz);
      place(lampPost, xMid - dx, 0, zMid + dz);
      place(lampPost, xMid + dx, 0, zMid + dz);
    }
  }

  // ── 25 fire hydrants: one per block, on the south sidewalk
  // halfway along the block's east-west extent.
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const { x, z } = blockCentre(col, row);
      // South-edge sidewalk midpoint.
      place(fireHydrant, x - 30, 0, z + BLOCK_LONG / 2 - 1.5);
    }
  }

  // ── 20 cars: one parked on each long-street segment at a small
  // jitter along Z. Cars also get a per-instance body-colour cycle
  // via the city-car wrapper's `body_color` input so the city has
  // some chromatic variety on the roads.
  const carColours: [number, number, number, number][] = [
    [0.75, 0.18, 0.18, 1],  // red
    [0.18, 0.20, 0.28, 1],  // dark blue
    [0.92, 0.92, 0.94, 1],  // white
    [0.20, 0.22, 0.20, 1],  // dark
    [0.85, 0.78, 0.20, 1],  // yellow taxi
  ];
  for (let col = 0; col < COLS - 1; col++) {
    const xStreet = (col - (COLS - 1) / 2 + 0.5) * X_SPACING;
    for (let row = 0; row < ROWS; row++) {
      const zBlock = (row - (ROWS - 1) / 2) * Z_SPACING;
      // Park each car a couple metres into the lane so it doesn't
      // sit on the centerline. Alternate sides for visual variety.
      const lateral = row % 2 === 0 ? -3.5 : 3.5;
      const carZ = zBlock + (row % 2 === 0 ? -40 : 40);
      const colour = carColours[(col + row) % carColours.length]!;
      place(car, xStreet + lateral, 0, carZ, row % 2 === 0 ? 0 : Math.PI, {
        body_color: colour,
      });
    }
  }

  // ── Big scene-merge: one input per accumulated scene ref. The
  // merge is variadic; we declare exactly N extra inputs to match.
  const extraInputs = sceneRefs.map((_, i) => ({
    name: `scene_${i}`,
    type: 'Scene' as const,
    optional: true,
  }));
  const mergeY = nextLayoutY();
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL_X * 4, y: mergeY },
    extraInputs,
  });
  sceneRefs.forEach((ref, i) => {
    addEdge(g, { node: ref.nodeId, socket: ref.socket }, { node: merge.id, socket: `scene_${i}` });
  });

  const output = addNode(g, 'core/output', {
    position: { x: COL_X * 5, y: mergeY },
    // The default light direction is too steep for an overhead city
    // overview — the long shadows from individual buildings on
    // adjacent buildings read as noise. Soften by raising the sun
    // and warming it slightly.
    inputValues: {
      light_direction: [0.4, 0.85, 0.3],
      light_intensity: 2.5,
      ambient_intensity: 1.4,
      fog_density: 0.0008,
    },
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [
      sidewalk, longStreet, shortStreet, intersection,
      tower, office, apartment, shop,
      lampPost, trafficSignal, fireHydrant, car,
    ],
    cameras: {
      // High-angle overview from the south, looking north over the
      // grid. Distance picked so the full 600×1100m footprint fits
      // in the default field of view.
      main: {
        yaw: 0.5,
        pitch: 0.55,
        distance: 1200,
        target: [0, 30, 0],
      },
    },
  };
}
