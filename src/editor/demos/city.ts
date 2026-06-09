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

function buildBuildingPerimeterBodySubgraph(
  bodyId: string,
  buildingSubgraph: SubgraphDef,
  perimeterSpacing: number,
): SubgraphDef {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bodyId}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${bodyId}`, { position: { x: COL * 5, y: ROW } });
  const perim = addNode(g, 'core/polygon-perimeter-points', {
    position: { x: COL, y: ROW },
    inputValues: { spacing: perimeterSpacing, y: 0 },
  });
  const wrap = addNode(g, `subgraph/${buildingSubgraph.id}`, {
    position: { x: COL * 2, y: 0 },
  });
  const scat = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 3, y: ROW },
    inputValues: { scale: 1, align: true },
  });
  addEdge(g, { node: inputNode.id, socket: 'polygon' }, { node: perim.id, socket: 'polygon' });
  addEdge(g, { node: perim.id, socket: 'points' }, { node: scat.id, socket: 'points' });
  addEdge(g, { node: wrap.id, socket: 'scene' }, { node: scat.id, socket: 'instance' });
  addEdge(g, { node: scat.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });
  return {
    id: bodyId,
    label: 'Block perimeter buildings',
    category: 'Subgraphs',
    inputs: [{ name: 'polygon', type: 'Polygon' }],
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
  // Spacing well above the office's 21 m width keeps corner
  // buildings from overlapping each other. Adjacent buildings along
  // the same edge end up with ~15 m of clear gap.
  const bodySubgraph = buildBuildingPerimeterBodySubgraph(
    `body-${forEachId}`, office, 36,
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

  // ── Road meshes. Take the SAME line set, clip to the city
  // footprint, buffer each line to ROAD_WIDTH, triangulate the
  // resulting road polygons into one combined mesh, and attach an
  // asphalt material. One entity, one batch.
  {
    const roadsLane = nextLane() * ROW_Y;
    const roadBuffer = addNode(g, 'core/polyline-buffer-list', {
      position: { x: 0, y: roadsLane },
      inputValues: { lines: linesFlat, width: ROAD_WIDTH },
    });
    const roadMesh = addNode(g, 'core/polygon-list-to-mesh', {
      position: { x: COL_X, y: roadsLane },
      // Slightly above the grass ground so the asphalt wins z-fight.
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

  // NOTE: chunk-4's grid-aligned overlays (rectangular sidewalks,
  // long/short street segments, intersections, traffic signals,
  // lamp posts, fire hydrants, cars) lived on a fixed 5×5 grid and
  // are intentionally not scattered here — they would overlap the
  // organic Tokyo blocks visually. Road-mesh rendering on top of the
  // polygon-defined road network is its own follow-up (polyline-
  // buffer + per-edge polygon emission).

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
