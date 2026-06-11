import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Modular parametric tower, Houdini-style. FOUR modules:
//
//   1. `tower-lobby`           — 6 m lobby with large lobby-glass panels.
//   2. `tower-body-floor`      — one 2.5 m glass-curtain-wall floor
//                                (one box; instanced N times via
//                                scene/instance-on-points in the
//                                assembled subgraph).
//   3. `tower-setback-floor`   — one 2.5 m narrower setback floor
//                                (instanced M times; setback width =
//                                60% of body width — the classic
//                                skyscraper crown silhouette).
//   4. `tower-roof-cap`        — 1 m solid concrete crown.
//   5. `tower-assembled`       — composes all four. num_floors is
//                                multiplied internally so the tower's
//                                silhouette dominates: body floors
//                                = num_floors × 2, setback floors
//                                = floor(num_floors × 0.8).
//
// Visual differentiation:
//   • Dense vertical-mullion glass curtain wall (10 cols × 1 row per
//     floor) → the "downtown skyscraper" silhouette
//   • Setback section pulls in to 60% width → distinctive crown
//   • Tallest variant by far — dominates the skyline at silhouette
//     distance, distinct from the office's 5+(N×3.5)+0.6 m mid-rise
//   • Cool dark glass; no facade decorations (no awnings, no signs,
//     no fire escapes — modern downtown towers don't have those)
//
// Surface contract (width, depth, num_floors → scene) matches the
// other variants so the per-lot bridge can dispatch all four through
// one scene/switch.

const COL = 240;
const ROW = 160;

const LOBBY_HEIGHT = 6;
const BODY_FLOOR_HEIGHT = 2.5;
const SETBACK_FLOOR_HEIGHT = 2.5;
const ROOF_HEIGHT = 1;
const SETBACK_WIDTH_RATIO = 0.6;
// Tower body floor count = num_floors × this. With default num_floors
// = 7, body becomes 14 floors (35 m) → the silhouette dominates.
const BODY_FLOOR_MULTIPLIER = 2;
// Setback floors = floor(num_floors × this). Default → 5 floors
// (12.5 m). Adds up to lobby 6 + body 35 + setback 12.5 + roof 1
// = 54.5 m, close to the original fixed-tower's 55 m.
const SETBACK_FLOOR_MULTIPLIER = 0.8;

const METAL_MULLION:    [number, number, number, number] = [0.55, 0.60, 0.65, 1];
const CURTAIN_GLASS:    [number, number, number, number] = [0.08, 0.12, 0.18, 1];
const SETBACK_GLASS:    [number, number, number, number] = [0.05, 0.09, 0.14, 1];
const LOBBY_GLASS:      [number, number, number, number] = [0.08, 0.14, 0.20, 1];
const CROWN_CONCRETE:   [number, number, number, number] = [0.40, 0.42, 0.45, 1];

// ────────────────────────────────────────────────────────────────────
// Module 1: lobby (6 m large-glass entry).
// ────────────────────────────────────────────────────────────────────

export function buildTowerLobbySubgraph(): SubgraphDef {
  const id = 'tower-lobby';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Single floor of huge lobby glass (6 panels × 1 row).
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: METAL_MULLION,
      bg: LOBBY_GLASS,
      divisions: [6, 1],
      line_width: 0.04,
      resolution: 256,
    },
  });

  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { width: 26, height: LOBBY_HEIGHT, depth: 26 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: {
      translate: [0, LOBBY_HEIGHT / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2.5 },
    inputValues: { roughness: 0.35, metallic: 0.2 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower · lobby',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 26 },
      { name: 'depth', type: 'Float', default: 26 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 2: body floor (2.5 m curtain-wall unit).
// ────────────────────────────────────────────────────────────────────

export function buildTowerBodyFloorSubgraph(): SubgraphDef {
  const id = 'tower-body-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // 10 vertical mullions × 1 row per floor → curtain-wall band when
  // floors stack.
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: METAL_MULLION,
      bg: CURTAIN_GLASS,
      divisions: [10, 1],
      line_width: 0.06,
      resolution: 256,
    },
  });

  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 25, height: BODY_FLOOR_HEIGHT, depth: 25 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.3, metallic: 0.25 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower · body floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 25 },
      { name: 'depth', type: 'Float', default: 25 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 3: setback floor (2.5 m narrower band, darker glass).
// ────────────────────────────────────────────────────────────────────

export function buildTowerSetbackFloorSubgraph(): SubgraphDef {
  const id = 'tower-setback-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Setback uses a sparser grid (8 cols) and DARKER glass, so the
  // crown reads as a distinct upper section from the body.
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: METAL_MULLION,
      bg: SETBACK_GLASS,
      divisions: [8, 1],
      line_width: 0.06,
      resolution: 256,
    },
  });

  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 18, height: SETBACK_FLOOR_HEIGHT, depth: 18 },
  });
  // Caller supplies the already-narrowed width / depth.
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.3, metallic: 0.25 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower · setback floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 18 },
      { name: 'depth', type: 'Float', default: 18 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 4: roof cap (1 m concrete crown).
// ────────────────────────────────────────────────────────────────────
//
// Authored at LOCAL Y=0 with the crown's CENTRE at Y=0. The assembled
// subgraph places it at world Y so the crown sits on top of the
// setback. Sized to match the setback width (not the body) so the
// silhouette tapers cleanly.

export function buildTowerRoofCapSubgraph(): SubgraphDef {
  const id = 'tower-roof-cap';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 18, height: ROOF_HEIGHT, depth: 18 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { basecolor: CROWN_CONCRETE, roughness: 0.75, metallic: 0.1 },
  });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower · roof cap',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 18 },
      { name: 'depth', type: 'Float', default: 18 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Assembly: lobby + N body floors + M setback floors + roof.
// ────────────────────────────────────────────────────────────────────

export function buildTowerAssembledSubgraph(): SubgraphDef {
  const id = 'tower-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 5 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 9, y: ROW * 5 } });

  // ── Derived parametric values ─────────────────────────────────────
  // bodyFloors    = num_floors * BODY_FLOOR_MULTIPLIER
  // bodyHeight    = bodyFloors * BODY_FLOOR_HEIGHT
  // setbackFloors = num_floors * SETBACK_FLOOR_MULTIPLIER  (floored
  //                 inside scene/instance-on-points; points/line just
  //                 takes count as Float and Math.floors it)
  // setbackHeight = setbackFloors * SETBACK_FLOOR_HEIGHT
  // setbackWidth  = width  * SETBACK_WIDTH_RATIO
  // setbackDepth  = depth  * SETBACK_WIDTH_RATIO
  //
  // Y stacking:
  //   lobby            : [0,                 LOBBY_HEIGHT]
  //   body floors      : [LOBBY_HEIGHT,      LOBBY_HEIGHT + bodyHeight]
  //   setback floors   : [bodyTopY,          bodyTopY + setbackHeight]
  //   roof cap         : [setbackTopY,       setbackTopY + ROOF_HEIGHT]
  const bodyFloors = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 0 },
    inputValues: { b: BODY_FLOOR_MULTIPLIER },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: bodyFloors.id, socket: 'a' });

  const bodyHeight = addNode(g, 'math/multiply', {
    position: { x: COL * 2, y: ROW * 0 },
    inputValues: { b: BODY_FLOOR_HEIGHT },
  });
  addEdge(g, { node: bodyFloors.id, socket: 'result' }, { node: bodyHeight.id, socket: 'a' });

  const bodyTopY = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 0 },
    inputValues: { b: LOBBY_HEIGHT },
  });
  addEdge(g, { node: bodyHeight.id, socket: 'result' }, { node: bodyTopY.id, socket: 'a' });

  // First body-floor centre = LOBBY_HEIGHT + BODY_FLOOR_HEIGHT / 2.
  const firstBodyCentreY = LOBBY_HEIGHT + BODY_FLOOR_HEIGHT / 2;
  const lastBodyCentreY = addNode(g, 'math/add', {
    position: { x: COL * 4, y: ROW * 0 },
    inputValues: { b: -BODY_FLOOR_HEIGHT / 2 },
  });
  addEdge(g, { node: bodyTopY.id, socket: 'result' }, { node: lastBodyCentreY.id, socket: 'a' });

  const setbackFloors = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 1 },
    inputValues: { b: SETBACK_FLOOR_MULTIPLIER },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: setbackFloors.id, socket: 'a' });

  const setbackHeight = addNode(g, 'math/multiply', {
    position: { x: COL * 2, y: ROW * 1 },
    inputValues: { b: SETBACK_FLOOR_HEIGHT },
  });
  addEdge(g, { node: setbackFloors.id, socket: 'result' }, { node: setbackHeight.id, socket: 'a' });

  const setbackTopY = addNode(g, 'math/add', {
    position: { x: COL * 4, y: ROW * 1 },
    inputValues: { b: 0 },
  });
  addEdge(g, { node: bodyTopY.id,      socket: 'result' }, { node: setbackTopY.id, socket: 'a' });
  addEdge(g, { node: setbackHeight.id, socket: 'result' }, { node: setbackTopY.id, socket: 'b' });

  const firstSetbackCentreY = addNode(g, 'math/add', {
    position: { x: COL * 4, y: ROW * 1.5 },
    inputValues: { b: SETBACK_FLOOR_HEIGHT / 2 },
  });
  addEdge(g, { node: bodyTopY.id, socket: 'result' }, { node: firstSetbackCentreY.id, socket: 'a' });

  const lastSetbackCentreY = addNode(g, 'math/add', {
    position: { x: COL * 5, y: ROW * 1.5 },
    inputValues: { b: -SETBACK_FLOOR_HEIGHT / 2 },
  });
  addEdge(g, { node: setbackTopY.id, socket: 'result' }, { node: lastSetbackCentreY.id, socket: 'a' });

  const roofCentreY = addNode(g, 'math/add', {
    position: { x: COL * 5, y: ROW * 2 },
    inputValues: { b: ROOF_HEIGHT / 2 },
  });
  addEdge(g, { node: setbackTopY.id, socket: 'result' }, { node: roofCentreY.id, socket: 'a' });

  // Setback width / depth = body × SETBACK_WIDTH_RATIO.
  const setbackWidth = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { b: SETBACK_WIDTH_RATIO },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: setbackWidth.id, socket: 'a' });
  const setbackDepth = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 2.5 },
    inputValues: { b: SETBACK_WIDTH_RATIO },
  });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: setbackDepth.id, socket: 'a' });

  // ── Lobby module ──────────────────────────────────────────────────
  const lobbyWrap = addNode(g, 'subgraph/tower-lobby', {
    position: { x: COL * 2, y: ROW * 3 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: lobbyWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: lobbyWrap.id, socket: 'depth' });

  // ── Body floors instanced via points/line ─────────────────────────
  const bodyStart = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 4 },
    inputValues: { x: 0, y: firstBodyCentreY, z: 0 },
  });
  const bodyEnd = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 5, y: ROW * 4 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: lastBodyCentreY.id, socket: 'result' }, { node: bodyEnd.id, socket: 'y' });

  const bodyPts = addNode(g, 'points/line', {
    position: { x: COL * 6, y: ROW * 4 },
    inputValues: { start: [0, firstBodyCentreY, 0], end: [0, 0, 0], count: 14 },
  });
  addEdge(g, { node: bodyStart.id,  socket: 'value' },  { node: bodyPts.id, socket: 'start' });
  addEdge(g, { node: bodyEnd.id,    socket: 'value' },  { node: bodyPts.id, socket: 'end' });
  addEdge(g, { node: bodyFloors.id, socket: 'result' }, { node: bodyPts.id, socket: 'count' });

  const bodyFloorWrap = addNode(g, 'subgraph/tower-body-floor', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: bodyFloorWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: bodyFloorWrap.id, socket: 'depth' });
  const bodyScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 7, y: ROW * 4 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: bodyPts.id,       socket: 'points' }, { node: bodyScatter.id, socket: 'points' });
  addEdge(g, { node: bodyFloorWrap.id, socket: 'scene' },  { node: bodyScatter.id, socket: 'instance' });

  // ── Setback floors instanced via points/line ──────────────────────
  const setbackPts = addNode(g, 'points/line', {
    position: { x: COL * 6, y: ROW * 5 },
    inputValues: { start: [0, 0, 0], end: [0, 0, 0], count: 5 },
  });
  const setbackStart = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: firstSetbackCentreY.id, socket: 'result' }, { node: setbackStart.id, socket: 'y' });
  const setbackEndVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 5, y: ROW * 5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: lastSetbackCentreY.id, socket: 'result' }, { node: setbackEndVec.id, socket: 'y' });
  addEdge(g, { node: setbackStart.id,  socket: 'value' },  { node: setbackPts.id, socket: 'start' });
  addEdge(g, { node: setbackEndVec.id, socket: 'value' },  { node: setbackPts.id, socket: 'end' });
  addEdge(g, { node: setbackFloors.id, socket: 'result' }, { node: setbackPts.id, socket: 'count' });

  const setbackFloorWrap = addNode(g, 'subgraph/tower-setback-floor', {
    position: { x: COL * 2, y: ROW * 5 },
  });
  addEdge(g, { node: setbackWidth.id, socket: 'result' }, { node: setbackFloorWrap.id, socket: 'width' });
  addEdge(g, { node: setbackDepth.id, socket: 'result' }, { node: setbackFloorWrap.id, socket: 'depth' });
  const setbackScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 7, y: ROW * 5 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: setbackPts.id,        socket: 'points' }, { node: setbackScatter.id, socket: 'points' });
  addEdge(g, { node: setbackFloorWrap.id,  socket: 'scene' },  { node: setbackScatter.id, socket: 'instance' });

  // ── Roof cap (sized to the setback) ───────────────────────────────
  const roofWrap = addNode(g, 'subgraph/tower-roof-cap', {
    position: { x: COL * 2, y: ROW * 6 },
  });
  addEdge(g, { node: setbackWidth.id, socket: 'result' }, { node: roofWrap.id, socket: 'width' });
  addEdge(g, { node: setbackDepth.id, socket: 'result' }, { node: roofWrap.id, socket: 'depth' });
  const roofLiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 6 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: roofCentreY.id, socket: 'result' }, { node: roofLiftVec.id, socket: 'y' });
  const roofLift = addNode(g, 'scene/transform', {
    position: { x: COL * 7, y: ROW * 6 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: roofWrap.id,    socket: 'scene' }, { node: roofLift.id, socket: 'scene' });
  addEdge(g, { node: roofLiftVec.id, socket: 'value' }, { node: roofLift.id, socket: 'translate' });

  // ── Merge ─────────────────────────────────────────────────────────
  const merge = addNode(g, 'scene/merge', { position: { x: COL * 8, y: ROW * 5 } });
  addEdge(g, { node: lobbyWrap.id,      socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: bodyScatter.id,    socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: setbackScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: roofLift.id,       socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower (assembled)',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 26 },
      { name: 'depth',      type: 'Float', default: 26 },
      { name: 'num_floors', type: 'Float', default: 7 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
