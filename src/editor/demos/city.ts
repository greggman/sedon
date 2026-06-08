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

// 5×5 city demo. Built around `core/instance-scene-on-points` so each
// repeated element ships as one instanced draw rather than N hand-
// placed entities. All randomisation runs against a fixed seed so
// the build is deterministic and the asset bundle is reproducible.
//
// Density targets (per user request):
//   • Every block's perimeter is packed flush against the sidewalk
//     with 4 building types alternating. Towers anchor the NW/SE
//     corners, offices the NE/SW; the rest of each edge is a
//     cycling office/apartment/shop run.
//   • Street lamps every 25m along both sides of every street.
//   • ~400 cars in 4 lanes (2 per direction), random per-lane jitter
//     and random spacing along the street, four body colours.
//   • A traffic signal at every corner of every intersection (4 per
//     intersection × 16 intersections = 64), with the arm rotated
//     so each signal hangs over a different edge of its
//     intersection.

const STREET_WIDTH = 18;
const BLOCK_SHORT = 100;
const BLOCK_LONG = 200;
const COLS = 5;
const ROWS = 5;
const X_SPACING = BLOCK_SHORT + STREET_WIDTH;  // 118
const Z_SPACING = BLOCK_LONG + STREET_WIDTH;   // 218
const SIDEWALK_INSET = 3;
const INNER_X = BLOCK_SHORT / 2 - SIDEWALK_INSET;  // 47
const INNER_Z = BLOCK_LONG / 2 - SIDEWALK_INSET;   // 97

// Building footprints (world units, metres). Width runs along X,
// depth along Z in the building subgraph's local frame; we don't
// rotate the source scene before scattering, so for buildings on
// the W/E edges of a block their "depth" actually packs along Z and
// their "width" projects into the block — this is fine because the
// window grids look the same from any side.
const BUILDING_FOOTPRINTS: Record<BuildingType, { width: number; depth: number }> = {
  tower:     { width: 26, depth: 26 },
  office:    { width: 21, depth: 26 },
  apartment: { width: 18, depth: 22 },
  shop:      { width: 14, depth: 15 },
};

const LAMP_SPACING = 25;
const LAMP_INSET = STREET_WIDTH / 2 + 1.5;  // from street centerline to lamp post (m)

const LANE_HALF_WIDTH = 4.5;
// Lane centerline offsets from street centerline. 4.5m lanes.
// Lanes 0/1 → one direction; lanes 2/3 → the other.
const LANE_OFFSETS = [-1.5 * LANE_HALF_WIDTH, -0.5 * LANE_HALF_WIDTH, 0.5 * LANE_HALF_WIDTH, 1.5 * LANE_HALF_WIDTH];

const CAR_COLORS: { name: string; rgb: [number, number, number, number] }[] = [
  { name: 'red',    rgb: [0.75, 0.18, 0.18, 1] },
  { name: 'blue',   rgb: [0.18, 0.22, 0.55, 1] },
  { name: 'white',  rgb: [0.92, 0.92, 0.94, 1] },
  { name: 'yellow', rgb: [0.85, 0.78, 0.20, 1] },
];

type Vec3 = [number, number, number];
type BuildingType = 'tower' | 'office' | 'apartment' | 'shop';

// Deterministic PRNG. Same input → same city layout on every build,
// so the bundled .sedon file is reproducible and screenshot diffs
// don't churn.
function mulberry32(seed: number): () => number {
  let s = (seed | 0) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Block-perimeter building packer ─────────────────────────────────
// Places buildings flush against a single block's sidewalk inner
// edge. Corners get anchor buildings (tower on NW/SE, office on
// NE/SW); the middle of each edge is packed by walking a cursor with
// types cycling through office/apartment/shop.
//
// Buildings don't get per-edge rotation — the source subgraph's
// orientation stays as authored, and we just pick the right axis
// (width or depth) when computing slot width and inward offset.
type BuildingBuckets = Record<BuildingType, Vec3[]>;

function packBlockPerimeter(blockX: number, blockZ: number, buckets: BuildingBuckets): void {
  const tower = BUILDING_FOOTPRINTS.tower;
  const office = BUILDING_FOOTPRINTS.office;
  // Corners. NW/SE anchored by towers; NE/SW by offices. Their
  // outer-most face sits at the block's sidewalk inner edge.
  buckets.tower.push([blockX - (INNER_X - tower.width / 2),  0, blockZ - (INNER_Z - tower.depth / 2)]);   // NW
  buckets.tower.push([blockX + (INNER_X - tower.width / 2),  0, blockZ + (INNER_Z - tower.depth / 2)]);   // SE
  buckets.office.push([blockX + (INNER_X - office.width / 2), 0, blockZ - (INNER_Z - office.depth / 2)]); // NE
  buckets.office.push([blockX - (INNER_X - office.width / 2), 0, blockZ + (INNER_Z - office.depth / 2)]); // SW

  const middleTypes: BuildingType[] = ['office', 'apartment', 'shop'];
  // For each edge, reserve the corner anchor's relevant dimension on
  // each end and pack the middle.
  // N edge: NW=tower(width 26), NE=office(width 21).
  packEdge(blockX, blockZ, buckets, middleTypes, 'N', tower.width, office.width);
  // S edge: SW=office, SE=tower.
  packEdge(blockX, blockZ, buckets, middleTypes, 'S', office.width, tower.width);
  // W edge: NW=tower(depth 26), SW=office(depth 26).
  packEdge(blockX, blockZ, buckets, middleTypes, 'W', tower.depth, office.depth);
  // E edge: NE=office(depth 26), SE=tower(depth 26).
  packEdge(blockX, blockZ, buckets, middleTypes, 'E', office.depth, tower.depth);
}

function packEdge(
  blockX: number,
  blockZ: number,
  buckets: BuildingBuckets,
  types: BuildingType[],
  edge: 'N' | 'S' | 'W' | 'E',
  cornerReserveStart: number,
  cornerReserveEnd: number,
): void {
  const gap = 1.5;
  let i = (edge === 'N' || edge === 'S') ? 0 : 1;  // stagger so adjacent edges don't match
  if (edge === 'N' || edge === 'S') {
    // Pack along X. Z is fixed at the sidewalk inner edge; buildings
    // extend inward (towards block centre) by half their depth.
    const z = edge === 'N' ? blockZ - INNER_Z : blockZ + INNER_Z;
    const inwardSign = edge === 'N' ? +1 : -1;
    let cursor = -INNER_X + cornerReserveStart;
    const endCursor = INNER_X - cornerReserveEnd;
    let safety = 0;
    while (cursor < endCursor && safety++ < 32) {
      const t = types[i % types.length]!;
      const f = BUILDING_FOOTPRINTS[t];
      if (cursor + f.width > endCursor) { i++; continue; }
      buckets[t].push([
        blockX + cursor + f.width / 2,
        0,
        z + inwardSign * f.depth / 2,
      ]);
      cursor += f.width + gap;
      i++;
    }
  } else {
    // Pack along Z. X is fixed; inward = block centre.
    const x = edge === 'W' ? blockX - INNER_X : blockX + INNER_X;
    const inwardSign = edge === 'W' ? +1 : -1;
    let cursor = -INNER_Z + cornerReserveStart;
    const endCursor = INNER_Z - cornerReserveEnd;
    let safety = 0;
    while (cursor < endCursor && safety++ < 32) {
      const t = types[i % types.length]!;
      const f = BUILDING_FOOTPRINTS[t];
      if (cursor + f.depth > endCursor) { i++; continue; }
      buckets[t].push([
        x + inwardSign * f.width / 2,
        0,
        blockZ + cursor + f.depth / 2,
      ]);
      cursor += f.depth + gap;
      i++;
    }
  }
}

// ── Lamp post points ────────────────────────────────────────────────
// Returns one big point list of lamp positions: every LAMP_SPACING
// metres along both sidewalks of every street, plus the 4 corners
// of every intersection (the modulo-25 cadence usually skips the
// intersection corners themselves, so we add them explicitly).
function generateLampPoints(): Vec3[] {
  const out: Vec3[] = [];
  const longStreetXs: number[] = [];
  for (let c = 0; c < COLS - 1; c++) longStreetXs.push((c - (COLS - 1) / 2 + 0.5) * X_SPACING);
  const shortStreetZs: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) shortStreetZs.push((r - (ROWS - 1) / 2 + 0.5) * Z_SPACING);
  // City extent: a half-spacing beyond the outermost block centre.
  const halfX = (COLS - 1) / 2 * X_SPACING + BLOCK_SHORT / 2;
  const halfZ = (ROWS - 1) / 2 * Z_SPACING + BLOCK_LONG / 2;

  // Long-street sidewalks (lamps along Z, both sides of every N-S street).
  for (const sx of longStreetXs) {
    for (let z = -halfZ; z <= halfZ + 0.01; z += LAMP_SPACING) {
      out.push([sx - LAMP_INSET, 0, z]);
      out.push([sx + LAMP_INSET, 0, z]);
    }
  }
  // Short-street sidewalks (lamps along X, both sides of every E-W street).
  for (const sz of shortStreetZs) {
    for (let x = -halfX; x <= halfX + 0.01; x += LAMP_SPACING) {
      out.push([x, 0, sz - LAMP_INSET]);
      out.push([x, 0, sz + LAMP_INSET]);
    }
  }
  // Intersection corner extras (4 per intersection). Slightly offset
  // outside the intersection itself onto the corner sidewalk.
  for (const sx of longStreetXs) {
    for (const sz of shortStreetZs) {
      out.push([sx - LAMP_INSET, 0, sz - LAMP_INSET]);
      out.push([sx + LAMP_INSET, 0, sz - LAMP_INSET]);
      out.push([sx - LAMP_INSET, 0, sz + LAMP_INSET]);
      out.push([sx + LAMP_INSET, 0, sz + LAMP_INSET]);
    }
  }
  return out;
}

// ── Car distribution ────────────────────────────────────────────────
// Generates random car positions on every long-street + short-street
// segment, in 4 lanes (2 per direction) with random spacing and
// small lateral lane jitter. Each car gets a colour and a direction;
// the result is bucketed by `${colour}_${dir}` so the city graph
// can emit one scatter per bucket — minimum draw calls per colour
// variant while still giving cars different headings.
//
// Direction codes:
//   0: facing -Z (south)         — long-street west-side lanes
//   1: facing +Z (north)         — long-street east-side lanes
//   2: facing +X (east)          — short-street north-side lanes
//   3: facing -X (west)          — short-street south-side lanes
type CarBuckets = Map<string, Vec3[]>;

function generateCars(): CarBuckets {
  const out: CarBuckets = new Map();
  const push = (color: number, dir: number, p: Vec3) => {
    const key = `${color}_${dir}`;
    let arr = out.get(key);
    if (!arr) { arr = []; out.set(key, arr); }
    arr.push(p);
  };
  const rng = mulberry32(0xc17ca5);

  const longStreetXs: number[] = [];
  for (let c = 0; c < COLS - 1; c++) longStreetXs.push((c - (COLS - 1) / 2 + 0.5) * X_SPACING);
  const shortStreetZs: number[] = [];
  for (let r = 0; r < ROWS - 1; r++) shortStreetZs.push((r - (ROWS - 1) / 2 + 0.5) * Z_SPACING);

  // Cars on long streets (running N-S, so cars travel ±Z). Cover the
  // full city extent — cars in intersections look fine at this
  // resolution and the alternative (segmenting around intersections)
  // costs density.
  const halfZ = (ROWS - 1) / 2 * Z_SPACING + BLOCK_LONG / 2;
  for (const sx of longStreetXs) {
    for (let lane = 0; lane < 4; lane++) {
      const baseDir = lane < 2 ? 0 : 1;
      const baseX = sx + LANE_OFFSETS[lane]!;
      let z = -halfZ + 4 + rng() * 18;
      while (z < halfZ - 4) {
        const jitterX = (rng() - 0.5) * 1.4;        // ±0.7m jitter inside the lane
        const color = Math.floor(rng() * CAR_COLORS.length);
        push(color, baseDir, [baseX + jitterX, 0, z]);
        z += 14 + rng() * 14;                       // 14–28m spacing
      }
    }
  }

  // Cars on short streets (running E-W, so cars travel ±X). Lane
  // offsets here are along Z because the source car subgraph faces
  // +Z by default — we'll rotate that ±90° via the wrapper transform.
  const halfX = (COLS - 1) / 2 * X_SPACING + BLOCK_SHORT / 2;
  for (const sz of shortStreetZs) {
    for (let lane = 0; lane < 4; lane++) {
      const baseDir = lane < 2 ? 2 : 3;
      const baseZ = sz + LANE_OFFSETS[lane]!;
      let x = -halfX + 4 + rng() * 18;
      while (x < halfX - 4) {
        const jitterZ = (rng() - 0.5) * 1.4;
        const color = Math.floor(rng() * CAR_COLORS.length);
        push(color, baseDir, [x, 0, baseZ + jitterZ]);
        x += 14 + rng() * 14;
      }
    }
  }
  return out;
}

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

  const sceneRefs: { nodeId: string; socket: string }[] = [];

  // ─ Scatter helper ──────────────────────────────────────────────
  // One source scene replayed at every point as one instanced batch.
  // `yRot` rotates the source scene before scattering (used for the
  // short-street segments + east/west-facing cars). `wrapperInputValues`
  // sets the source subgraph wrapper's inputs (used for car body
  // colour).
  function scatter(
    sg: SubgraphDef,
    points: Vec3[],
    opts: {
      yRot?: number;
      wrapperInputValues?: Record<string, unknown>;
    } = {},
  ): void {
    if (points.length === 0) return;
    const y = nextLane() * ROW_Y;

    const wrap = addNode(g, `subgraph/${sg.id}`, {
      position: { x: 0, y },
      ...(opts.wrapperInputValues ? { inputValues: opts.wrapperInputValues } : {}),
    });
    let sourceRef = { node: wrap.id, socket: 'scene' };

    if (opts.yRot) {
      const rot = addNode(g, 'core/transform-scene', {
        position: { x: COL_X, y },
        inputValues: { translate: [0, 0, 0], rotate: [0, opts.yRot, 0], scale: [1, 1, 1] },
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

  // ── Ground plane: one entity, large enough to extend well past
  // the outermost block. -0.1m Y lift to dodge z-fighting with the
  // street/sidewalk surface at y=0.
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
    const ent = addNode(g, 'core/scene-entity', { position: { x: COL_X * 2, y } });
    addEdge(g, { node: plane.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    sceneRefs.push({ nodeId: ent.id, socket: 'scene' });
  }

  // ── 25 sidewalks (one per block).
  scatter(sidewalk, rectGrid(COLS, ROWS, X_SPACING, Z_SPACING));

  // ── ~22 buildings per block × 25 blocks ≈ 550 buildings. Each
  // type is one scatter, points pre-computed per block.
  const buildingBuckets: BuildingBuckets = { tower: [], office: [], apartment: [], shop: [] };
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const bx = (col - (COLS - 1) / 2) * X_SPACING;
      const bz = (row - (ROWS - 1) / 2) * Z_SPACING;
      packBlockPerimeter(bx, bz, buildingBuckets);
    }
  }
  scatter(tower, buildingBuckets.tower);
  scatter(office, buildingBuckets.office);
  scatter(apartment, buildingBuckets.apartment);
  scatter(shop, buildingBuckets.shop);

  // ── 20 long + 20 short street segments + 16 intersections.
  scatter(longStreet, rectGrid(COLS - 1, ROWS, X_SPACING, Z_SPACING));
  scatter(shortStreet, rectGrid(COLS, ROWS - 1, X_SPACING, Z_SPACING), { yRot: Math.PI / 2 });
  scatter(intersection, rectGrid(COLS - 1, ROWS - 1, X_SPACING, Z_SPACING));

  // ── 4 traffic signals per intersection (one per corner), each
  // rotated so its arm extends inward over a different edge of the
  // intersection. The subgraph's native arm direction is +X with the
  // signal head at the far end; rotating the wrapper Y by 0 / π/2 / π
  // / -π/2 gives N / E / S / W arm headings.
  const intersectionCentres = rectGrid(COLS - 1, ROWS - 1, X_SPACING, Z_SPACING);
  const sigNW: Vec3[] = []; const sigNE: Vec3[] = [];
  const sigSE: Vec3[] = []; const sigSW: Vec3[] = [];
  const sigD = STREET_WIDTH / 2 + 1.5;  // pole stands on the sidewalk 1.5m past the intersection corner
  for (const [cx, , cz] of intersectionCentres) {
    sigNW.push([cx - sigD, 0, cz - sigD]);
    sigNE.push([cx + sigD, 0, cz - sigD]);
    sigSE.push([cx + sigD, 0, cz + sigD]);
    sigSW.push([cx - sigD, 0, cz + sigD]);
  }
  scatter(trafficSignal, sigNW);                            // arm extends +X (east-over-intersection)
  scatter(trafficSignal, sigNE, { yRot: Math.PI / 2 });     // arm +Z (south)
  scatter(trafficSignal, sigSE, { yRot: Math.PI });         // arm -X (west)
  scatter(trafficSignal, sigSW, { yRot: -Math.PI / 2 });    // arm -Z (north)

  // ── Lamp posts. One big scatter with every street-side position
  // every 25m + intersection corner extras.
  scatter(lampPost, generateLampPoints());

  // ── ~25 fire hydrants (one per block on the south sidewalk).
  const blockCentres = rectGrid(COLS, ROWS, X_SPACING, Z_SPACING);
  scatter(fireHydrant,
    blockCentres.map(([x, , z]) => [x - 30, 0, z + BLOCK_LONG / 2 - 1.5] as Vec3));

  // ── ~400 cars in 4 lanes × 4 colours × 2-4 directions. One scatter
  // per (colour, direction) bucket; the wrapper's body_color input
  // tints the car body, and yRot orients each scatter.
  const cars = generateCars();
  for (const [key, pts] of cars) {
    const [colorStr, dirStr] = key.split('_');
    const color = CAR_COLORS[Number(colorStr)]!;
    const dir = Number(dirStr);
    // Direction code → wrapper yRot (rotates the source car scene
    // before the scatter clones it). 0/1 are long streets, 2/3 short.
    const yRotByDir = [Math.PI, 0, -Math.PI / 2, Math.PI / 2];
    scatter(car, pts, {
      yRot: yRotByDir[dir]!,
      wrapperInputValues: { body_color: color.rgb },
    });
  }

  // ── Big scene-merge → output.
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
      main: { yaw: 0.5, pitch: 0.55, distance: 1200, target: [0, 30, 0] },
    },
  };
}
