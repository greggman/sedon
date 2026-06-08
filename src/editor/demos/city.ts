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

// 5×5 city demo, built around `core/instance-scene-on-points`.
//
// Architecture
// ────────────
// Every repeated element (25 sidewalks, 20+20 street segments, 16
// intersections, 100 buildings, dozens of lamp posts / hydrants /
// cars) is placed by ONE scatter node fed by ONE programmatically-
// authored `core/point-list`. The scatter evaluates the source
// scene once, then replays it at every point — preserving the
// geometry+material object refs across instances, so the renderer
// batches them into a single instanced `drawIndexed` per (geo, mat)
// pair. The previous hand-placed version produced ~600 draw calls;
// this one targets ~20-30.
//
// The graph weighs in around ~50 nodes (down from ~618) and reads
// in the editor the way a Blender / Houdini city would: one row
// per scattered element, all merging into one output.
//
// World units are metres throughout.
//   • Block grid: 5 × 5, blocks 100 × 200m
//   • Streets: 18m wide
//   • Block-to-block centre spacing: 118m (X) × 218m (Z)
//   • Outer extent: ~600 × ~1100m
//
// Per-instance variety
// ────────────────────
// With a scatter, every instance is identical by default. Variety
// in the city comes from:
//   • Four distinct building subgraphs, one per quadrant of each
//     block (4 scatters with different quadrant offsets).
//   • Per-instance Y rotation on cars (alternates north/south by
//     row, generated via a Y-rotated source scene + a second car
//     scatter, so cars on adjacent streets face different ways).
//
// We deliberately don't randomise building heights / facade colours
// per-instance — that would require per-instance uniform variation
// which the current scatter doesn't support without per_point_tint.
// Adding that is its own chunk.

const STREET_WIDTH = 18;
const BLOCK_SHORT = 100;
const BLOCK_LONG = 200;
const COLS = 5;
const ROWS = 5;
const X_SPACING = BLOCK_SHORT + STREET_WIDTH;  // 118
const Z_SPACING = BLOCK_LONG + STREET_WIDTH;   // 218

// Building positions inside a block (relative to block centre).
// Block interior is ~94×194m (3m sidewalk inset); four quadrants
// of ~47×97m each give every building its own corner.
const QUAD = {
  NW: { x: -25, z: -50 },
  NE: { x:  25, z: -50 },
  SW: { x: -25, z:  50 },
  SE: { x:  25, z:  50 },
};

type Vec3 = [number, number, number];

// Build a regular rect-grid of points on the XZ plane centred at
// origin (with an optional XZ offset). Always Y=0 because point-list
// hard-codes Y to 0 anyway — instance-scene-on-points doesn't move
// the source scene's own origin, so any Y lift happens inside the
// subgraph.
function rectGrid(
  cols: number,
  rows: number,
  dx: number,
  dz: number,
  ox = 0,
  oz = 0,
): Vec3[] {
  const out: Vec3[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c - (cols - 1) / 2) * dx + ox;
      const z = (r - (rows - 1) / 2) * dz + oz;
      out.push([x, 0, z]);
    }
  }
  return out;
}

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

  const g = createGraph();
  const COL_X = 280;
  const ROW_Y = 220;
  let lane = 0;
  const nextLane = () => lane++;

  // Accumulated scene refs. One per scatter (or the ground plane).
  // All merged at the end.
  const sceneRefs: { nodeId: string; socket: string }[] = [];

  // ─ Scatter helper ──────────────────────────────────────────────
  // Places `sg` at every point in `points` as one instanced batch.
  // `yRot` rotates the source scene before scattering (useful for
  // the short-street subgraph whose internal long axis is Z but
  // which needs to lie along X). `bodyColor` is for the car
  // subgraph's `body_color` wrapper input.
  function scatter(
    sg: SubgraphDef,
    points: Vec3[],
    opts: {
      yRot?: number;
      wrapperInputValues?: Record<string, unknown>;
    } = {},
  ): void {
    const y = nextLane() * ROW_Y;

    const wrap = addNode(g, `subgraph/${sg.id}`, {
      position: { x: 0, y },
      ...(opts.wrapperInputValues ? { inputValues: opts.wrapperInputValues } : {}),
    });

    let sourceRef = { node: wrap.id, socket: 'scene' };

    if (opts.yRot) {
      const rot = addNode(g, 'core/transform-scene', {
        position: { x: COL_X, y },
        inputValues: {
          translate: [0, 0, 0],
          rotate: [0, opts.yRot, 0],
          scale: [1, 1, 1],
        },
      });
      addEdge(g, sourceRef, { node: rot.id, socket: 'scene' });
      sourceRef = { node: rot.id, socket: 'scene' };
    }

    const ptList = addNode(g, 'core/point-list', {
      position: { x: COL_X * 2, y: y + ROW_Y * 0.4 },
      inputValues: { points },
    });

    const scat = addNode(g, 'core/instance-scene-on-points', {
      position: { x: COL_X * 3, y },
      inputValues: { scale: 1, align: true },
    });

    addEdge(g, sourceRef, { node: scat.id, socket: 'instance' });
    addEdge(g, { node: ptList.id, socket: 'points' }, { node: scat.id, socket: 'points' });

    sceneRefs.push({ nodeId: scat.id, socket: 'scene' });
  }

  // ── Ground plane: one entity, ~1200×1800m, lifted -0.1m to avoid
  // z-fighting with the asphalt at y=0.
  {
    const y = nextLane() * ROW_Y;
    const plane = addNode(g, 'core/plane', {
      position: { x: 0, y },
      inputValues: { size: [1200, 1800], divisions: [1, 1] },
    });
    const lift = addNode(g, 'core/transform-geometry', {
      position: { x: COL_X, y },
      inputValues: { translate: [0, -0.1, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
    const mat = addNode(g, 'core/material', {
      position: { x: COL_X, y: y + 60 },
      inputValues: { basecolor: [0.30, 0.36, 0.26, 1], roughness: 0.95, metallic: 0 },
    });
    const ent = addNode(g, 'core/scene-entity', {
      position: { x: COL_X * 2, y },
    });
    addEdge(g, { node: plane.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    sceneRefs.push({ nodeId: ent.id, socket: 'scene' });
  }

  // ── 25 sidewalks: one per block, full 5×5 grid.
  scatter(sidewalk, rectGrid(COLS, ROWS, X_SPACING, Z_SPACING));

  // ── 100 buildings: 4 scatters, one per type, each on its own
  // 5×5 grid offset to a different quadrant of the block.
  scatter(tower,     rectGrid(COLS, ROWS, X_SPACING, Z_SPACING, QUAD.NW.x, QUAD.NW.z));
  scatter(office,    rectGrid(COLS, ROWS, X_SPACING, Z_SPACING, QUAD.NE.x, QUAD.NE.z));
  scatter(apartment, rectGrid(COLS, ROWS, X_SPACING, Z_SPACING, QUAD.SW.x, QUAD.SW.z));
  scatter(shop,      rectGrid(COLS, ROWS, X_SPACING, Z_SPACING, QUAD.SE.x, QUAD.SE.z));

  // ── 20 long street segments (4 cols × 5 rows). Streets sit
  // between block columns: a (COLS-1)-wide grid with the same
  // X-spacing as blocks centres each street midway between two
  // adjacent block columns automatically.
  scatter(longStreet, rectGrid(COLS - 1, ROWS, X_SPACING, Z_SPACING));

  // ── 20 short street segments (5 cols × 4 rows), rotated 90°Y so
  // the segment's internal long axis (Z) becomes X.
  scatter(shortStreet,
    rectGrid(COLS, ROWS - 1, X_SPACING, Z_SPACING),
    { yRot: Math.PI / 2 });

  // ── 16 intersections at every street crossing.
  scatter(intersection, rectGrid(COLS - 1, ROWS - 1, X_SPACING, Z_SPACING));

  // ── 16 traffic signals — one per intersection, biased to the SW
  // corner so the head extends over the road. (The traffic-signal
  // subgraph's arm extends in +X, so positioning the wrapper at the
  // intersection's SW corner and rotating 0° puts the head over the
  // road's centre.)
  const intersectionCentres = rectGrid(COLS - 1, ROWS - 1, X_SPACING, Z_SPACING);
  const signalPts: Vec3[] = intersectionCentres.map(
    ([x, , z]) => [x - STREET_WIDTH / 2 + 0.5, 0, z - STREET_WIDTH / 2 + 0.5],
  );
  scatter(trafficSignal, signalPts);

  // ── 64 lamp posts: one at each of the 4 corners of every
  // intersection (just inside the block on the sidewalk).
  const lampPts: Vec3[] = [];
  const d = STREET_WIDTH / 2 + 1.5;
  for (const [xc, , zc] of intersectionCentres) {
    lampPts.push([xc - d, 0, zc - d]);
    lampPts.push([xc + d, 0, zc - d]);
    lampPts.push([xc - d, 0, zc + d]);
    lampPts.push([xc + d, 0, zc + d]);
  }
  scatter(lampPost, lampPts);

  // ── 25 fire hydrants: one per block, on the south sidewalk.
  const blockCentres = rectGrid(COLS, ROWS, X_SPACING, Z_SPACING);
  scatter(fireHydrant,
    blockCentres.map(([x, , z]) => [x - 30, 0, z + BLOCK_LONG / 2 - 1.5] as Vec3));

  // ── 20 cars on the long streets, split into two scatters so half
  // face north and half face south. Even rows on the west side
  // facing -Z, odd rows on the east side facing +Z.
  const carsNorth: Vec3[] = [];
  const carsSouth: Vec3[] = [];
  const streetXs = [-1.5 * X_SPACING, -0.5 * X_SPACING, 0.5 * X_SPACING, 1.5 * X_SPACING];
  for (let i = 0; i < streetXs.length; i++) {
    const xs = streetXs[i]!;
    for (let row = 0; row < ROWS; row++) {
      const zBlock = (row - (ROWS - 1) / 2) * Z_SPACING;
      const facingSouth = (i + row) % 2 === 0;
      const lateral = facingSouth ? -3.5 : 3.5;
      const dz = facingSouth ? -40 : 40;
      (facingSouth ? carsSouth : carsNorth).push([xs + lateral, 0, zBlock + dz]);
    }
  }
  scatter(car, carsSouth);
  scatter(car, carsNorth, { yRot: Math.PI });

  // ── Big scene-merge: one input per accumulated scene ref.
  const extraInputs = sceneRefs.map((_, i) => ({
    name: `scene_${i}`,
    type: 'Scene' as const,
    optional: true,
  }));
  const mergeY = nextLane() * ROW_Y;
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL_X * 5, y: mergeY },
    extraInputs,
  });
  sceneRefs.forEach((ref, i) => {
    addEdge(g, { node: ref.nodeId, socket: ref.socket }, { node: merge.id, socket: `scene_${i}` });
  });

  const output = addNode(g, 'core/output', {
    position: { x: COL_X * 6, y: mergeY },
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
      sidewalk, longStreet, shortStreet, intersection,
      tower, office, apartment, shop,
      lampPost, trafficSignal, fireHydrant, car,
    ],
    cameras: {
      main: {
        yaw: 0.5,
        pitch: 0.55,
        distance: 1200,
        target: [0, 30, 0],
      },
    },
  };
}
