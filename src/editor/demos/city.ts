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

// ── Building-perimeter body + bridge subgraphs ─────────────────────
// For-each-polygon needs two private SubgraphDefs:
//
//   • BODY    — given one block polygon, produce a Scene of buildings
//               placed around its perimeter. (One polygon-perimeter-
//               points → one scatter → one scene.)
//   • BRIDGE  — wire the for-each-polygon's iteration-input.polygon
//               into the body's `polygon` input, and the body's
//               `scene` output back into iteration-output.scene.
//
// The body subgraph evaluates ONCE per iteration. The building
// wrapper inside the body is fingerprint-stable across iterations
// (its inputs don't change), so the eval cache returns the same
// SceneValue every time — and because the scatter preserves the
// geometry/material object refs across instances, the renderer's
// reference-equality batching unifies all 25 iteration's worth of
// buildings into a SINGLE instanced draw call per (geometry,
// material) pair. We don't pay 25× the GPU cost for the
// iteration architecture.

interface BuildingType {
  subgraph: SubgraphDef;
  // Half the geometry's X-axis extent (= half core/box width). After
  // scatter-align, this is how far the building reaches INWARD from
  // its origin in world space, so it doubles as the local-+X shift
  // needed to put the building's outer face on the polygon edge.
  halfInward: number;
  // Half the geometry's Z-axis extent (= half core/box depth). After
  // scatter-align, this is how far the building reaches ALONG the
  // polygon edge. The largest such value across building variants
  // sets the corner_clearance and perimeter spacing the body picks.
  halfEdge: number;
}

function buildBuildingPerimeterBodySubgraph(
  bodyId: string,
  // Building variants the body switches between by iteration index.
  // index % types.length picks the variant for each polygon. Provide
  // them in the visual rhythm you want (office, apartment, shop,
  // tower) — the scene-switch wires preserve insertion order.
  types: BuildingType[],
  perimeterSpacing: number,
  // Max halfEdge across `types`. Passed to polygon-perimeter-points
  // as corner_clearance so EVERY variant fits within its edge,
  // regardless of which one a given polygon ends up using.
  maxHalfEdge: number,
): SubgraphDef {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bodyId}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${bodyId}`, { position: { x: COL * 6, y: ROW } });
  const perim = addNode(g, 'core/polygon-perimeter-points', {
    position: { x: COL, y: ROW },
    inputValues: { spacing: perimeterSpacing, corner_clearance: maxHalfEdge, y: 0 },
  });
  // One wrap + shift per variant. Each shift uses its variant's own
  // halfInward so the outer face sits on the polygon edge regardless
  // of which variant scene-switch ends up selecting.
  const wrapEntries: { variantIndex: number; shiftId: string }[] = [];
  types.forEach((t, i) => {
    const wrap = addNode(g, `subgraph/${t.subgraph.id}`, {
      position: { x: COL * 2, y: i * ROW * 1.4 },
    });
    const shift = addNode(g, 'core/transform-scene', {
      position: { x: COL * 3, y: i * ROW * 1.4 },
      inputValues: {
        translate: [t.halfInward, 0, 0],
        rotate: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
    addEdge(g, { node: wrap.id, socket: 'scene' }, { node: shift.id, socket: 'scene' });
    wrapEntries.push({ variantIndex: i, shiftId: shift.id });
  });
  // scene-switch picks one variant by iteration index (mod
  // types.length). The selected scene feeds the scatter as
  // instance — the scatter then places it at every perimeter point.
  const swt = addNode(g, 'core/scene-switch', {
    position: { x: COL * 4, y: ROW },
    extraInputs: wrapEntries.map((e) => ({ name: `scene_${e.variantIndex}`, type: 'Scene' as const })),
  });
  for (const e of wrapEntries) {
    addEdge(g, { node: e.shiftId, socket: 'scene' }, { node: swt.id, socket: `scene_${e.variantIndex}` });
  }
  const scat = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 5, y: ROW },
    inputValues: { scale: 1, align: true },
  });
  addEdge(g, { node: inputNode.id, socket: 'polygon' }, { node: perim.id, socket: 'polygon' });
  addEdge(g, { node: inputNode.id, socket: 'index' }, { node: swt.id, socket: 'index' });
  addEdge(g, { node: perim.id, socket: 'points' }, { node: scat.id, socket: 'points' });
  addEdge(g, { node: swt.id, socket: 'scene' }, { node: scat.id, socket: 'instance' });
  addEdge(g, { node: scat.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });
  return {
    id: bodyId,
    label: 'Block perimeter buildings',
    category: 'Subgraphs',
    inputs: [
      { name: 'polygon', type: 'Polygon' },
      { name: 'index', type: 'Int' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

function buildBuildingPerimeterBridgeSubgraph(
  forEachId: string,
  body: SubgraphDef,
): SubgraphDef {
  const bridgeId = `bridge-${forEachId}`;
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bridgeId}`, { position: { x: 0, y: 0 } });
  const iterInputNode = addNode(g, `iteration-input/${bridgeId}`, { position: { x: 0, y: ROW } });
  const iterOutputNode = addNode(g, `iteration-output/${bridgeId}`, { position: { x: COL * 3, y: ROW } });
  const bodyNode = addNode(g, `subgraph/${body.id}`, { position: { x: COL * 1.5, y: ROW } });
  addEdge(g, { node: iterInputNode.id, socket: 'polygon' }, { node: bodyNode.id, socket: 'polygon' });
  addEdge(g, { node: iterInputNode.id, socket: 'index' },   { node: bodyNode.id, socket: 'index' });
  addEdge(g, { node: bodyNode.id, socket: 'scene' }, { node: iterOutputNode.id, socket: 'scene' });
  return {
    id: bridgeId,
    label: 'Block buildings bridge',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: iterOutputNode.id,
    owner: { kind: 'iteration-bridge', nodeId: forEachId },
    iterationKind: 'core/for-each-polygon',
  };
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

  // ── Ground polygon: the city's footprint as a Polygon → triangulated
  // mesh → scene entity. Rectangular today (polygon-aabb), but the
  // pipeline is now polygon-based — once polygon-difference /
  // polygon-offset / for-each-polygon land, this same chain hosts a
  // hand-drawn city outline with canals carved out as holes, all
  // without restructuring the scene.
  // -0.1m Y so the ground sits below the street/sidewalk surface
  // at y=0 (no z-fighting).
  {
    const y = nextLane() * ROW_Y;
    const aabb = addNode(g, 'core/polygon-aabb', {
      position: { x: 0, y },
      inputValues: { center: [0, 0], size: [1200, 1800] },
    });
    const mesh = addNode(g, 'core/polygon-to-mesh', {
      position: { x: COL_X, y },
      inputValues: { y: -0.1 },
    });
    const mat = addNode(g, 'core/material', {
      position: { x: COL_X, y: y + 60 },
      inputValues: { basecolor: [0.30, 0.36, 0.26, 1], roughness: 0.95, metallic: 0 },
    });
    const ent = addNode(g, 'core/scene-entity', { position: { x: COL_X * 2, y } });
    addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: mesh.id, socket: 'polygon' });
    addEdge(g, { node: mesh.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    sceneRefs.push({ nodeId: ent.id, socket: 'scene' });
  }

  // ── Buildings via the polygon pipeline (Tokyo-ish road network).
  //
  // The chain:
  //   1. polygon-aabb                        — city footprint
  //   2. polygon-subdivide-by-lines          → PolygonList(irregular blocks)
  //   3. polygon-list-offset(-12 m)          → blocks inset by sidewalk +
  //                                            half a road width so the
  //                                            gap between adjacent
  //                                            blocks reads as a street
  //   4. for-each-polygon                    → body per block
  //   5. body subgraph                       → perimeter-points → scatter
  //
  // The 6 authored lines mix verticals, horizontals, and two
  // diagonals — the result is ~20–30 irregular blocks instead of the
  // 25-cell grid the chunk-4 demo had. Authoring is hardcoded here
  // because we haven't shipped a per-road UI yet; the user-facing
  // editor will land alongside organic-road authoring in a future
  // chunk.
  // Shared road centerlines — fed into BOTH the block subdivision
  // (so the streets cut the city into blocks) AND the road-mesh
  // buffer (so we render those streets as asphalt). Authored here
  // as a const so the two consumers stay in sync.
  const ROAD_LINES: [number, number, number][][] = [
    // Two N-S arteries.
    [[-100, 0, -600], [-100, 0, 600]],
    [[ 120, 0, -600], [ 120, 0, 600]],
    // Two E-W arteries.
    [[-400, 0, -180], [ 400, 0, -180]],
    [[-400, 0,  200], [ 400, 0,  200]],
    // Two diagonals for organic feel.
    [[-200, 0, -350], [ 200, 0,  350]],
    [[-150, 0,  400], [ 250, 0, -300]],
  ];
  const ROAD_WIDTH = 18;
  // Inset = half road width + sidewalk so buildings sit `SIDEWALK`
  // metres back from the asphalt edge.
  const SIDEWALK = 3;
  const BLOCK_INSET = ROAD_WIDTH / 2 + SIDEWALK;
  const linesFlat = ROAD_LINES.flat();

  const buildingsLane = nextLane() * ROW_Y;
  const cityW = COLS * X_SPACING - STREET_WIDTH;
  const cityD = ROWS * Z_SPACING - STREET_WIDTH;
  const cityFootprint = addNode(g, 'core/polygon-aabb', {
    position: { x: 0, y: buildingsLane },
    inputValues: { center: [0, 0], size: [cityW, cityD] },
  });
  const blockSplit = addNode(g, 'core/polygon-subdivide-by-lines', {
    position: { x: COL_X, y: buildingsLane },
    inputValues: { lines: linesFlat },
  });
  const blockInset = addNode(g, 'core/polygon-list-offset', {
    position: { x: COL_X * 2, y: buildingsLane },
    inputValues: { offset: -BLOCK_INSET, miter_limit: 4 },
  });
  const forEachId = 'city-blocks';
  // Building footprints (core/box width × depth — width ends up
  // INWARD in world, depth ends up ALONG the polygon edge after
  // scatter-align; see body-subgraph builder for the axis mapping).
  // The body cycles between these by iteration index, so each block
  // gets a different building. corner_clearance and PERIMETER_SPACING
  // are sized for the LARGEST variant so every variant fits.
  const BUILDING_TYPES: BuildingType[] = [
    { subgraph: office,    halfInward: 21 / 2, halfEdge: 26 / 2 },
    { subgraph: apartment, halfInward: 18 / 2, halfEdge: 22 / 2 },
    { subgraph: shop,      halfInward: 14 / 2, halfEdge: 15 / 2 },
    { subgraph: tower,     halfInward: 26 / 2, halfEdge: 26 / 2 },
  ];
  const MAX_HALF_EDGE = Math.max(...BUILDING_TYPES.map((t) => t.halfEdge));
  const MAX_HALF_INWARD = Math.max(...BUILDING_TYPES.map((t) => t.halfInward));
  // Spacing 1 m above the largest variant's edge extent so adjacent
  // buildings on the same edge have ≥1 m gap regardless of which
  // variant scene-switch picks.
  const PERIMETER_SPACING = MAX_HALF_EDGE * 2 + 1;
  // Corner clearance has to cover BOTH a building's edge-axis extent
  // (so it doesn't overhang a vertex along its own edge) AND the
  // perpendicular building on the adjacent edge (which sticks inward
  // by halfInward there, into our edge's airspace within halfInward
  // of the corner). For a ~90° corner with same-size buildings the
  // sum keeps them flush instead of interpenetrating; for sharper
  // angles you'd need more, but the road graph here is mostly
  // near-orthogonal so the sum suffices.
  const CORNER_CLEARANCE = MAX_HALF_EDGE + MAX_HALF_INWARD;
  const bodySubgraph = buildBuildingPerimeterBodySubgraph(
    `body-${forEachId}`, BUILDING_TYPES, PERIMETER_SPACING, CORNER_CLEARANCE,
  );
  const bridgeSubgraph = buildBuildingPerimeterBridgeSubgraph(forEachId, bodySubgraph);
  const blocksForEach = addNode(g, 'core/for-each-polygon', {
    id: forEachId,
    position: { x: COL_X * 3, y: buildingsLane },
    inputValues: { __bridgeId: bridgeSubgraph.id },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: cityFootprint.id, socket: 'polygon' }, { node: blockSplit.id, socket: 'polygon' });
  addEdge(g, { node: blockSplit.id, socket: 'polygons' }, { node: blockInset.id, socket: 'polygons' });
  addEdge(g, { node: blockInset.id, socket: 'polygons' }, { node: blocksForEach.id, socket: 'polygons' });
  sceneRefs.push({ nodeId: blocksForEach.id, socket: 'scene' });

  // ── Sidewalk + asphalt meshes. Same `linesFlat` set, buffered
  // twice — once wide (road + sidewalks both sides) and once narrow
  // (just the asphalt). The wide grey strip renders FIRST (lower Y),
  // the narrow asphalt on top (higher Y), so the 3m of extra width
  // on each side shows through as a sidewalk strip flush with the
  // road on one side and with the building polygon edge on the other.
  {
    const sidewalkLane = nextLane() * ROW_Y;
    const sidewalkBuffer = addNode(g, 'core/polyline-buffer-list', {
      position: { x: 0, y: sidewalkLane },
      inputValues: { lines: linesFlat, width: ROAD_WIDTH + 2 * SIDEWALK },
    });
    const sidewalkMesh = addNode(g, 'core/polygon-list-to-mesh', {
      position: { x: COL_X, y: sidewalkLane },
      // Just above the grass ground so asphalt-vs-sidewalk z-fight
      // resolves predictably (sidewalk < asphalt < grass+0.1m).
      inputValues: { y: 0.005 },
    });
    const sidewalkMat = addNode(g, 'core/material', {
      position: { x: COL_X, y: sidewalkLane + 60 },
      // Pale concrete grey, low metallic, high roughness.
      inputValues: { basecolor: [0.78, 0.77, 0.74, 1], roughness: 0.9, metallic: 0 },
    });
    const sidewalkEnt = addNode(g, 'core/scene-entity', {
      position: { x: COL_X * 2, y: sidewalkLane },
    });
    addEdge(g, { node: cityFootprint.id, socket: 'polygon' }, { node: sidewalkBuffer.id, socket: 'clip' });
    addEdge(g, { node: sidewalkBuffer.id, socket: 'polygons' }, { node: sidewalkMesh.id, socket: 'polygons' });
    addEdge(g, { node: sidewalkMesh.id, socket: 'geometry' }, { node: sidewalkEnt.id, socket: 'geometry' });
    addEdge(g, { node: sidewalkMat.id, socket: 'material' }, { node: sidewalkEnt.id, socket: 'material' });
    sceneRefs.push({ nodeId: sidewalkEnt.id, socket: 'scene' });
  }
  {
    const roadsLane = nextLane() * ROW_Y;
    const roadBuffer = addNode(g, 'core/polyline-buffer-list', {
      position: { x: 0, y: roadsLane },
      inputValues: { lines: linesFlat, width: ROAD_WIDTH },
    });
    const roadMesh = addNode(g, 'core/polygon-list-to-mesh', {
      position: { x: COL_X, y: roadsLane },
      inputValues: { y: 0.01 },
    });
    const roadMat = addNode(g, 'core/material', {
      position: { x: COL_X, y: roadsLane + 60 },
      inputValues: { basecolor: [0.18, 0.18, 0.19, 1], roughness: 0.95, metallic: 0 },
    });
    const roadEnt = addNode(g, 'core/scene-entity', {
      position: { x: COL_X * 2, y: roadsLane },
    });
    addEdge(g, { node: cityFootprint.id, socket: 'polygon' }, { node: roadBuffer.id, socket: 'clip' });
    addEdge(g, { node: roadBuffer.id, socket: 'polygons' }, { node: roadMesh.id, socket: 'polygons' });
    addEdge(g, { node: roadMesh.id, socket: 'geometry' }, { node: roadEnt.id, socket: 'geometry' });
    addEdge(g, { node: roadMat.id, socket: 'material' }, { node: roadEnt.id, socket: 'material' });
    sceneRefs.push({ nodeId: roadEnt.id, socket: 'scene' });
  }

  // ── Lamp posts. One per kerb, every LAMP_SPACING metres along each
  // road centreline. polyline-points samples the same `linesFlat`
  // (road centrelines) as the asphalt mesh, offset perpendicular by
  // ±LAMP_OFFSET so points land just outside the asphalt on each
  // sidewalk. Two scatters (one per side) into one scene-merge.
  // end_clearance keeps lamps from landing exactly at a road junction
  // where they'd clip into the cross-street.
  {
    const LAMP_SPACING = 25;
    // Asphalt half-width + a touch so lamps sit at the curb (not in
    // the road, not buried in the building line).
    const LAMP_OFFSET = ROAD_WIDTH / 2 + 1.5;
    const LAMP_END_CLEARANCE = ROAD_WIDTH / 2 + 4;
    // Each road line runs straight through every intersection, so
    // without this the lamp walk lands posts in the middle of the
    // cross-street. The asphalt half-width plus a small margin clears
    // the intersection cleanly while still letting lamps sit on the
    // approach kerb on either side.
    const LAMP_INTERSECTION_AVOID = ROAD_WIDTH / 2 + 4;
    const lampsLane = nextLane() * ROW_Y;
    const lampSubgraph = `subgraph/${lampPost.id}`;
    const lampWrapL = addNode(g, lampSubgraph, { position: { x: 0, y: lampsLane } });
    const lampWrapR = addNode(g, lampSubgraph, { position: { x: 0, y: lampsLane + ROW_Y * 0.4 } });
    const ptsLeft = addNode(g, 'core/polyline-points', {
      position: { x: COL_X, y: lampsLane },
      inputValues: {
        lines: linesFlat,
        spacing: LAMP_SPACING,
        end_clearance: LAMP_END_CLEARANCE,
        side_offset:  LAMP_OFFSET,
        self_avoid_radius: LAMP_INTERSECTION_AVOID,
        y: 0,
      },
    });
    const ptsRight = addNode(g, 'core/polyline-points', {
      position: { x: COL_X, y: lampsLane + ROW_Y * 0.4 },
      inputValues: {
        lines: linesFlat,
        spacing: LAMP_SPACING,
        end_clearance: LAMP_END_CLEARANCE,
        side_offset: -LAMP_OFFSET,
        self_avoid_radius: LAMP_INTERSECTION_AVOID,
        y: 0,
      },
    });
    const scatL = addNode(g, 'core/instance-scene-on-points', {
      position: { x: COL_X * 2, y: lampsLane },
      inputValues: { scale: 1, align: true },
    });
    const scatR = addNode(g, 'core/instance-scene-on-points', {
      position: { x: COL_X * 2, y: lampsLane + ROW_Y * 0.4 },
      inputValues: { scale: 1, align: true },
    });
    addEdge(g, { node: ptsLeft.id,  socket: 'points' }, { node: scatL.id, socket: 'points' });
    addEdge(g, { node: lampWrapL.id, socket: 'scene' }, { node: scatL.id, socket: 'instance' });
    addEdge(g, { node: ptsRight.id, socket: 'points' }, { node: scatR.id, socket: 'points' });
    addEdge(g, { node: lampWrapR.id, socket: 'scene' }, { node: scatR.id, socket: 'instance' });
    sceneRefs.push({ nodeId: scatL.id, socket: 'scene' });
    sceneRefs.push({ nodeId: scatR.id, socket: 'scene' });
  }

  // NOTE: chunk-4's grid-aligned overlays (long/short street segments,
  // intersections, traffic signals, fire hydrants, cars) lived on a
  // fixed 5×5 grid and are intentionally not scattered here — they
  // would overlap the organic Tokyo blocks visually. Per-polyline
  // versions of those follow the same `polyline-points` pattern this
  // lamp pass uses.

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
      bodySubgraph, bridgeSubgraph,
    ],
    cameras: {
      main: { yaw: 0.5, pitch: 0.55, distance: 1200, target: [0, 30, 0] },
    },
  };
}
