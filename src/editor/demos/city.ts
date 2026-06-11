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
  buildOfficeAssembledSubgraph,
  buildOfficeGroundFloorSubgraph,
  buildOfficeRoofCapSubgraph,
  buildOfficeUpperFloorSubgraph,
} from './city-office.js';
import {
  buildApartmentAssembledSubgraph,
  buildApartmentGroundFloorSubgraph,
  buildApartmentRoofCapSubgraph,
  buildApartmentUpperFloorSubgraph,
} from './city-apartment.js';
import {
  buildShopAssembledSubgraph,
  buildShopGroundFloorSubgraph,
  buildShopRoofCapSubgraph,
  buildShopUpperFloorSubgraph,
} from './city-shop.js';
import {
  buildTowerAssembledSubgraph,
  buildTowerBodyFloorSubgraph,
  buildTowerLobbySubgraph,
  buildTowerRoofCapSubgraph,
  buildTowerSetbackFloorSubgraph,
} from './city-tower.js';
import {
  buildCarSubgraph,
  buildFireHydrantSubgraph,
  buildLampPostSubgraph,
  buildTrafficSignalSubgraph,
} from './city-furniture.js';
import {
  buildHvacUnitSubgraph,
  buildWaterTankSubgraph,
} from './city-rooftop.js';
import {
  buildAwningSubgraph,
} from './city-storefront.js';
import { buildWallSignSubgraph } from './city-billboard.js';
import {
  buildWallAcUnitSubgraph,
} from './city-wall-ac.js';
import {
  buildFireEscapeAssembledSubgraph,
  buildFireEscapeBottomModuleSubgraph,
  buildFireEscapeFloorModuleSubgraph,
  buildFireEscapeTopModuleSubgraph,
} from './city-fire-escape.js';
import {
  buildBlockSidewalkSubgraph,
  buildIntersectionSubgraph,
  buildStreetSegmentLongSubgraph,
  buildStreetSegmentShortSubgraph,
} from './city-streets.js';

// 5×5 city demo. Built around `scene/instance-on-points` so each
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

// ─── Per-lot body subgraph ────────────────────────────────────────
// The innermost graph the for-each-point invokes ONCE per lot. Takes
// the lot's (width, yaw, num_floors) as broadcast inputs and its
// (position) as iteration context, and emits a parametric office
// sized to the lot, oriented along its inward direction, with its
// OUTER face flush against the polygon edge.
//
// The chain inside:
//   1. parametric-office(width, depth=fixed, num_floors)   → office scene
//   2. transform-scene(translate=[width/2, 0, 0])           → shift outer face to origin
//   3. transform-scene(translate=position, rotate=[0,yaw,0]) → rotate to inward direction, place at lot centre
//
// Eval-cache effect: identical (width, num_floors) tuples re-use the
// office GeometryValue from the cache. With `width_step` quantising
// widths to whole metres and num_floors held constant per block, we
// get O(range) unique office geometries shared across all lots.
// Per-lot variant dispatcher. Reusable named subgraph that takes
// (width, depth, num_floors) and emits `scene` — fanning the same
// inputs into N parametric building variants and routing the
// width-picked one through scene/switch. Adding a new variant later
// is a 2-line change here (register the wrapper + add it to the
// switch's `scenes` fan-in) plus the variant's own subgraph
// authoring.
//
// `scene/switch.scenes` is `lazy: true`, so unselected variants
// never evaluate per lot — see src/core/node-def.ts InputDef.lazy.
// Without that, every lot would run ALL FOUR variant graphs every
// round.
//
// Picker rule: width in [MIN_LOT_WIDTH .. MAX_LOT_WIDTH] maps to
// [0 .. 3.999], floored inside scene/switch. Zoning by lot size:
//   • narrowest  → shop      (2-floor mixed-use, fixed height)
//   • narrow-mid → apartment (5-floor residential, no setback)
//   • mid-wide   → office    (mid-rise commercial w/ facade detail)
//   • widest     → tower     (skyscraper w/ setback crown)
//
// Reads as natural zoning — wider lots get bigger / taller / more
// commercial — without any random per-lot churn.
function buildBuildingSelectSubgraph(opts: { minWidth: number; maxWidth: number }): SubgraphDef {
  const id = 'building-select';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 3 } });

  // Variant 0: shop. Narrowest lots — small-business mixed-use.
  const shopWrap = addNode(g, 'subgraph/shop-assembled', {
    position: { x: COL * 2, y: ROW * 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' },      { node: shopWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' },      { node: shopWrap.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: shopWrap.id, socket: 'num_floors' });

  // Variant 1: apartment. Narrow-mid — residential.
  const apartmentWrap = addNode(g, 'subgraph/apartment-assembled', {
    position: { x: COL * 2, y: ROW * 2 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' },      { node: apartmentWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' },      { node: apartmentWrap.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: apartmentWrap.id, socket: 'num_floors' });

  // Variant 2: office. Mid-wide — mid-rise commercial.
  const officeWrap = addNode(g, 'subgraph/office-assembled', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' },      { node: officeWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' },      { node: officeWrap.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: officeWrap.id, socket: 'num_floors' });

  // Variant 3: tower. Widest lots — skyscraper with setback crown.
  const towerWrap = addNode(g, 'subgraph/tower-assembled', {
    position: { x: COL * 2, y: ROW * 6 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' },      { node: towerWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' },      { node: towerWrap.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: towerWrap.id, socket: 'num_floors' });

  // Width → variant index. out_max stops just short of 4 so the
  // widest possible lot picks variant 3, not variant 0 (which would
  // happen if we landed exactly on 4 — `((4 % 4) + 4) % 4` = 0).
  const picker = addNode(g, 'math/map-range', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      in_min: opts.minWidth,
      in_max: opts.maxWidth,
      out_min: 0,
      out_max: 3.999,
    },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: picker.id, socket: 'value' });

  // scene/switch with `scenes` as a lazy multi-fan-in. Wire order
  // is significant — 0=shop, 1=apartment, 2=office, 3=tower.
  const sw = addNode(g, 'scene/switch', {
    position: { x: COL * 4, y: ROW * 3 },
    inputValues: { index: 0 },
  });
  addEdge(g, { node: picker.id,        socket: 'result' }, { node: sw.id, socket: 'index' });
  addEdge(g, { node: shopWrap.id,      socket: 'scene' },  { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: apartmentWrap.id, socket: 'scene' },  { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: officeWrap.id,    socket: 'scene' },  { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: towerWrap.id,     socket: 'scene' },  { node: sw.id, socket: 'scenes' });
  addEdge(g, { node: sw.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Building select',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 20 },
      { name: 'depth',      type: 'Float', default: 22 },
      { name: 'num_floors', type: 'Float', default: 6 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

function buildLotBodySubgraph(bodyId: string, officeDepth: number): SubgraphDef {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bodyId}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${bodyId}`, { position: { x: COL * 6, y: ROW } });

  // Variant dispatcher. Inputs come from this body's subgraph-input
  // boundary; the wrapper resolves to the `building-select`
  // subgraph (which internally fans width/depth/num_floors into N
  // parametric building variants and picks one by width via a lazy
  // scene/switch).
  const wrap = addNode(g, 'subgraph/building-select', {
    position: { x: COL, y: 0 },
    inputValues: { depth: officeDepth },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' },      { node: wrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: wrap.id, socket: 'num_floors' });

  // halfWidth = width * 0.5 — used for the inner shift that puts the
  // building's outer face on the polygon edge after rotation.
  const halfWidth = addNode(g, 'math/map-range', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 0.5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: halfWidth.id, socket: 'value' });

  // [halfWidth, 0, 0] for the inner shift.
  const shiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: halfWidth.id, socket: 'result' }, { node: shiftVec.id, socket: 'x' });

  // [0, yaw, 0] for the rotation around Y.
  const rotateVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'yaw' }, { node: rotateVec.id, socket: 'y' });

  // Step 2: inner shift. Translates the office along its OWN +X so
  // its outer face (originally at local x = -halfInward = -width/2)
  // ends up at local x = 0, ready for the rotate+place pass.
  const innerShift = addNode(g, 'scene/transform', {
    position: { x: COL * 3, y: 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: wrap.id, socket: 'scene' },     { node: innerShift.id, socket: 'scene' });
  addEdge(g, { node: shiftVec.id, socket: 'value' }, { node: innerShift.id, socket: 'translate' });

  // Step 3: rotate then place. transform-scene applies T*R*S — its
  // rotation pivots around the LOCAL origin of the inner-shifted
  // scene (= the building's outer face), then translates to the
  // lot's position. Net effect: outer face lands ON the lot centre,
  // building extends inward.
  const place = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: innerShift.id, socket: 'scene' }, { node: place.id, socket: 'scene' });
  addEdge(g, { node: inputNode.id, socket: 'position' }, { node: place.id, socket: 'translate' });
  addEdge(g, { node: rotateVec.id, socket: 'value' }, { node: place.id, socket: 'rotate' });
  addEdge(g, { node: place.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id: bodyId,
    label: 'Lot body',
    category: 'Subgraphs',
    inputs: [
      // `position` is iteration-input from for-each-point; the bridge
      // wires iteration-input.position → this `position` input by
      // name match. The rest are broadcast inputs whose Float wires
      // travel through for-each-point as FloatClouds.
      { name: 'position',   type: 'Vec3',  default: [0, 0, 0] },
      { name: 'width',      type: 'Float', default: 20 },
      { name: 'yaw',        type: 'Float', default: 0 },
      { name: 'num_floors', type: 'Float', default: 7 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Bridge subgraph for for-each-point. Wraps the per-lot body so the
// outer for-each-point sees `width`/`yaw`/`num_floors` as broadcast
// inputs (FloatClouds when wired from lots, plain Floats when
// constant), and the iteration's `position` is routed to the body's
// `position` input.
function buildLotBridgeSubgraph(forEachId: string, lotBody: SubgraphDef): SubgraphDef {
  const bridgeId = `bridge-${forEachId}`;
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bridgeId}`, { position: { x: 0, y: 0 } });
  const iterInputNode = addNode(g, `iteration-input/${bridgeId}`, { position: { x: 0, y: ROW } });
  const iterOutputNode = addNode(g, `iteration-output/${bridgeId}`, { position: { x: COL * 3, y: ROW } });
  const bodyNode = addNode(g, `subgraph/${lotBody.id}`, { position: { x: COL * 1.5, y: ROW } });
  addEdge(g, { node: iterInputNode.id, socket: 'position' }, { node: bodyNode.id, socket: 'position' });
  addEdge(g, { node: inputNode.id, socket: 'width' },        { node: bodyNode.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'yaw' },          { node: bodyNode.id, socket: 'yaw' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' },   { node: bodyNode.id, socket: 'num_floors' });
  addEdge(g, { node: bodyNode.id, socket: 'scene' }, { node: iterOutputNode.id, socket: 'scene' });
  return {
    id: bridgeId,
    label: 'Per-lot bridge',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 20 },
      { name: 'yaw',        type: 'Float', default: 0 },
      { name: 'num_floors', type: 'Float', default: 7 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: iterOutputNode.id,
    owner: { kind: 'iteration-bridge', nodeId: forEachId },
    iterationKind: 'iter/for-each-point',
  };
}

// Block-level body. Called ONCE per polygon by for-each-polygon.
// Subdivides the polygon's perimeter into lots and runs a
// for-each-point over those lots with the per-lot bridge.
function buildBlockBodySubgraph(
  bodyId: string,
  lotBridge: SubgraphDef,
  opts: { minWidth: number; maxWidth: number; cornerClearance: number; numFloors: number },
): SubgraphDef {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const inputNode = addNode(g, `subgraph-input/${bodyId}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${bodyId}`, { position: { x: COL * 5, y: ROW } });

  const lots = addNode(g, 'poly/edge-lots', {
    position: { x: COL, y: ROW },
    inputValues: {
      min_width: opts.minWidth,
      max_width: opts.maxWidth,
      width_step: 1,
      corner_clearance: opts.cornerClearance,
      gap: 1,
      seed: 17,
    },
  });
  addEdge(g, { node: inputNode.id, socket: 'polygon' }, { node: lots.id, socket: 'polygon' });

  // for-each-point iterates lots. Broadcast inputs come straight
  // from the lots node's FloatClouds (widths, yaws). num_floors is a
  // constant for now — a future chunk can drive it from a random
  // per-lot cloud for height variety.
  const foreach = addNode(g, 'iter/for-each-point', {
    position: { x: COL * 3, y: ROW },
    inputValues: {
      __bridgeId: lotBridge.id,
      num_floors: opts.numFloors,
    },
    extraInputs: [
      { name: 'width', type: 'FloatCloud' },
      { name: 'yaw',   type: 'FloatCloud' },
      { name: 'num_floors', type: 'Float' },
    ],
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: lots.id, socket: 'points' }, { node: foreach.id, socket: 'points' });
  addEdge(g, { node: lots.id, socket: 'widths' }, { node: foreach.id, socket: 'width' });
  addEdge(g, { node: lots.id, socket: 'yaws' },   { node: foreach.id, socket: 'yaw' });
  addEdge(g, { node: foreach.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id: bodyId,
    label: 'Block body (parametric lots)',
    category: 'Subgraphs',
    inputs: [
      { name: 'polygon', type: 'Polygon' },
      { name: 'index',   type: 'Int' },
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
    iterationKind: 'iter/for-each-polygon',
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
  // Parametric office is the workhorse for the building lot
  // iteration — it's the only one currently driven by polygon-edge-
  // lots. The hand-authored variants above remain available as
  // Assets the user can drag/instantiate directly.
  //
  // Decomposed Houdini-style into four subgraphs:
  //   • office-ground-floor — 5 m storefront band
  //   • office-upper-floor  — one 3.5 m floor (instanced N times)
  //   • office-roof-cap     — parapet + HVAC + water tanks
  //   • office-assembled    — composes them + facade decorations
  // All four are registered so each wrapper inside office-assembled
  // resolves at eval time.
  const officeGroundFloor = buildOfficeGroundFloorSubgraph();
  const officeUpperFloor = buildOfficeUpperFloorSubgraph();
  const officeRoofCap = buildOfficeRoofCapSubgraph();
  const parametricOffice = buildOfficeAssembledSubgraph();
  // Modular parametric apartment. Same Houdini-style decomposition as
  // the parametric office (ground / upper / roof modules + an
  // assembled composer), authored with a distinct visual signature
  // (beige concrete, denser windows, no setback, no facade
  // decorations) so the city reads as having residential + commercial
  // mixed-use at silhouette distance.
  const apartmentGroundFloor = buildApartmentGroundFloorSubgraph();
  const apartmentUpperFloor = buildApartmentUpperFloorSubgraph();
  const apartmentRoofCap = buildApartmentRoofCapSubgraph();
  const parametricApartment = buildApartmentAssembledSubgraph();
  // Modular parametric shop — 2-floor mixed-use, cream concrete +
  // bright storefront. Always 2 floors (semantically a shop is
  // low-rise; num_floors is accepted for signature parity but
  // ignored).
  const shopGroundFloor = buildShopGroundFloorSubgraph();
  const shopUpperFloor = buildShopUpperFloorSubgraph();
  const shopRoofCap = buildShopRoofCapSubgraph();
  const parametricShop = buildShopAssembledSubgraph();
  // Modular parametric tower — five modules (lobby + body floor +
  // setback floor + roof). num_floors is multiplied internally
  // (×2 for body, ×0.8 for setback) so the tower dominates the
  // skyline. Setback section pulls in to 60% width for the
  // classic crown silhouette.
  const towerLobby = buildTowerLobbySubgraph();
  const towerBodyFloor = buildTowerBodyFloorSubgraph();
  const towerSetbackFloor = buildTowerSetbackFloorSubgraph();
  const towerRoofCap = buildTowerRoofCapSubgraph();
  const parametricTower = buildTowerAssembledSubgraph();
  // Rooftop fittings. The parametric office's body wires a scatter
  // of these on its +Y face, so registering them here is what makes
  // the `subgraph/city-roof-hvac` wrapper inside the office resolve
  // at eval time.
  const hvacUnit = buildHvacUnitSubgraph();
  const waterTank = buildWaterTankSubgraph();
  // Ground-floor storefront fittings. Same pattern — registered
  // here so the parametric office's `subgraph/city-storefront-
  // awning` wrapper resolves at eval time.
  const awning = buildAwningSubgraph();
  // Upper-wall illuminated signs — sparse scatter on the street-
  // facing -X wall, body region, with per-sign random saturated tint
  // and emissive bloom. The Spider-Man-2 NYC dusk lift.
  const wallSign = buildWallSignSubgraph();
  // Wall AC units stuck on the ±Z side walls of every parametric
  // office.
  const wallAc = buildWallAcUnitSubgraph();
  // Fire escape on the +Z side wall of (most) buildings — composed
  // from four module subgraphs the Houdini way:
  //   • fire-escape-floor   — one repeating floor (parametric)
  //   • fire-escape-bottom  — ground-level drop ladder + landing
  //   • fire-escape-top     — roof landing + roof-access ladder
  //   • fire-escape-assembled — composes the above into a complete
  //     fire escape sized for num_floors × floor_height
  const fireFloorMod = buildFireEscapeFloorModuleSubgraph();
  const fireBottomMod = buildFireEscapeBottomModuleSubgraph();
  const fireTopMod = buildFireEscapeTopModuleSubgraph();
  const fireEscape = buildFireEscapeAssembledSubgraph();
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
    const aabb = addNode(g, 'poly/aabb', {
      position: { x: 0, y },
      inputValues: { center: [0, 0], size: [1200, 1800] },
    });
    const mesh = addNode(g, 'geom/from-polygon', {
      position: { x: COL_X, y },
      inputValues: { y: -0.1 },
    });
    const mat = addNode(g, 'material/pbr', {
      position: { x: COL_X, y: y + 60 },
      inputValues: { basecolor: [0.30, 0.36, 0.26, 1], roughness: 0.95, metallic: 0 },
    });
    const ent = addNode(g, 'scene/entity', { position: { x: COL_X * 2, y } });
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
  const cityFootprint = addNode(g, 'poly/aabb', {
    position: { x: 0, y: buildingsLane },
    inputValues: { center: [0, 0], size: [cityW, cityD] },
  });
  const blockSplit = addNode(g, 'poly/subdivide-by-lines', {
    position: { x: COL_X, y: buildingsLane },
    inputValues: { lines: linesFlat },
  });
  const blockInset = addNode(g, 'poly/list-offset', {
    position: { x: COL_X * 2, y: buildingsLane },
    inputValues: { offset: -BLOCK_INSET, miter_limit: 4 },
  });
  const forEachId = 'city-blocks';
  // Continuous lot widths in [14, 28] m, quantised to 1 m steps so
  // the eval cache batches identical-width buildings. The parametric
  // office accepts any width and resizes its geometry + textures to
  // match; lot width = building's edge-axis extent.
  //
  // Corner clearance = 2 × (parametric office's max width / 2) =
  // max_lot_width. At a ~90° corner, the corner-most lot's inward-
  // projecting body (extending ≈ max_lot_width into the polygon)
  // shares airspace with the perpendicular edge's first
  // max_lot_width of length; pushing the first lot that far in
  // prevents interpenetration.
  const MIN_LOT_WIDTH = 14;
  const MAX_LOT_WIDTH = 28;
  const NUM_FLOORS = 7;
  // Office depth (perpendicular to street). Constant for now; future
  // chunks can drive it from a per-lot random or a city-wide style.
  const OFFICE_DEPTH = 22;
  const CORNER_CLEARANCE = MAX_LOT_WIDTH;

  // Variant dispatcher subgraph — wire MIN_LOT_WIDTH / MAX_LOT_WIDTH
  // here so the picker's input range matches the actual lot range
  // produced by poly/edge-lots. Authored once per city; instanced
  // every lot via subgraph/building-select inside the lot body.
  const buildingSelect = buildBuildingSelectSubgraph({
    minWidth: MIN_LOT_WIDTH,
    maxWidth: MAX_LOT_WIDTH,
  });
  const lotBodySubgraph = buildLotBodySubgraph(`lot-body-${forEachId}`, OFFICE_DEPTH);
  const lotForEachId = `lot-iter-${forEachId}`;
  const lotBridgeSubgraph = buildLotBridgeSubgraph(lotForEachId, lotBodySubgraph);
  const blockBody = buildBlockBodySubgraph(`body-${forEachId}`, lotBridgeSubgraph, {
    minWidth: MIN_LOT_WIDTH,
    maxWidth: MAX_LOT_WIDTH,
    cornerClearance: CORNER_CLEARANCE,
    numFloors: NUM_FLOORS,
  });
  const bridgeSubgraph = buildBuildingPerimeterBridgeSubgraph(forEachId, blockBody);
  const blocksForEach = addNode(g, 'iter/for-each-polygon', {
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
    const sidewalkBuffer = addNode(g, 'poly/polyline-buffer', {
      position: { x: 0, y: sidewalkLane },
      inputValues: { lines: linesFlat, width: ROAD_WIDTH + 2 * SIDEWALK },
    });
    const sidewalkMesh = addNode(g, 'geom/from-polygon-list', {
      position: { x: COL_X, y: sidewalkLane },
      // Just above the grass ground so asphalt-vs-sidewalk z-fight
      // resolves predictably (sidewalk < asphalt < grass+0.1m).
      inputValues: { y: 0.005 },
    });
    const sidewalkMat = addNode(g, 'material/pbr', {
      position: { x: COL_X, y: sidewalkLane + 60 },
      // Pale concrete grey, low metallic, high roughness.
      inputValues: { basecolor: [0.78, 0.77, 0.74, 1], roughness: 0.9, metallic: 0 },
    });
    const sidewalkEnt = addNode(g, 'scene/entity', {
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
    const roadBuffer = addNode(g, 'poly/polyline-buffer', {
      position: { x: 0, y: roadsLane },
      inputValues: { lines: linesFlat, width: ROAD_WIDTH },
    });
    const roadMesh = addNode(g, 'geom/from-polygon-list', {
      position: { x: COL_X, y: roadsLane },
      inputValues: { y: 0.01 },
    });
    const roadMat = addNode(g, 'material/pbr', {
      position: { x: COL_X, y: roadsLane + 60 },
      inputValues: { basecolor: [0.18, 0.18, 0.19, 1], roughness: 0.95, metallic: 0 },
    });
    const roadEnt = addNode(g, 'scene/entity', {
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
    const ptsLeft = addNode(g, 'points/from-polyline', {
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
    const ptsRight = addNode(g, 'points/from-polyline', {
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
    const scatL = addNode(g, 'scene/instance-on-points', {
      position: { x: COL_X * 2, y: lampsLane },
      inputValues: { scale: 1, align: true },
    });
    const scatR = addNode(g, 'scene/instance-on-points', {
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

  // ── Big scene-merge → output. multi-fan-in: every sceneRef wires
  // into the single `scenes` socket below; no per-instance slots needed.
  const mergeY = nextLane() * ROW_Y;
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL_X * 5, y: mergeY },
  });
  sceneRefs.forEach((ref) => {
    addEdge(g, { node: ref.nodeId, socket: ref.socket }, { node: merge.id, socket: 'scenes' });
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
      officeGroundFloor, officeUpperFloor, officeRoofCap, parametricOffice,
      apartmentGroundFloor, apartmentUpperFloor, apartmentRoofCap, parametricApartment,
      shopGroundFloor, shopUpperFloor, shopRoofCap, parametricShop,
      towerLobby, towerBodyFloor, towerSetbackFloor, towerRoofCap, parametricTower,
      // Width-keyed variant dispatcher. Wraps all 4 variants in a
      // scene/switch with lazy `scenes` — only the picked variant
      // evaluates per lot.
      buildingSelect,
      hvacUnit, waterTank, awning, wallSign, wallAc,
      fireFloorMod, fireBottomMod, fireTopMod, fireEscape,
      lampPost, trafficSignal, fireHydrant, car,
      // For-each-polygon's bridge → its body (= blockBody) →
      // for-each-point's bridge (lotBridgeSubgraph) → its body
      // (= lotBodySubgraph). All four need to be in the project's
      // subgraphs list so the registry knows how to resolve each
      // `subgraph/<id>` wrapper at eval time.
      lotBodySubgraph, lotBridgeSubgraph, blockBody, bridgeSubgraph,
    ],
    cameras: {
      main: { yaw: 0.5, pitch: 0.55, distance: 1200, target: [0, 30, 0] },
    },
  };
}
