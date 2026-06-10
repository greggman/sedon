import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Rooftop fittings that read as "real city" from above and from the
// street at low pitches: HVAC condensers and the iconic NYC-style
// wooden water tank. These are the cheapest visual upgrades for the
// Spider-Man-2-NYC silhouette goal — they put irregular shapes on
// what would otherwise be flat concrete pads.

const COL = 240;
const ROW = 160;

// Stack a single sized box with a flat-PBR material and wrap it as a
// scene entity. Used as the inner building block of every rooftop
// fixture below. `baseY` is the world-Y of the box's BASE (not its
// centre) since the iconic-form of "drop me on a rooftop point"
// expects local +Y = up off the roof.
function addRoofBox(
  g: ReturnType<typeof createGraph>,
  opts: {
    width: number;
    depth: number;
    height: number;
    baseY: number;
    materialInputs: Record<string, unknown>;
    yOffset: number;
    textureNode?: ReturnType<typeof addNode>;
  },
): ReturnType<typeof addNode> {
  const { width, depth, height, baseY, materialInputs, yOffset, textureNode } = opts;
  const geo = addNode(g, 'geom/box', {
    position: { x: COL, y: yOffset },
    inputValues: { width, height, depth },
  });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: yOffset },
    inputValues: {
      translate: [0, baseY + height / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  return ent;
}

// === HVAC unit: rooftop AC condenser =============================
export function buildHvacUnitSubgraph(): SubgraphDef {
  const id = 'city-roof-hvac';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });

  const body = addRoofBox(g, {
    width: 3, depth: 2, height: 2, baseY: 0,
    materialInputs: {
      basecolor: [0.55, 0.58, 0.60, 1],
      roughness: 0.55,
      metallic: 0.6,
    },
    yOffset: 0,
  });
  const intake = addRoofBox(g, {
    width: 2.4, depth: 1.6, height: 0.4, baseY: 2,
    materialInputs: {
      basecolor: [0.35, 0.38, 0.40, 1],
      roughness: 0.7,
      metallic: 0.4,
    },
    yOffset: ROW * 2,
  });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 3, y: ROW },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: body.id,   socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: intake.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Rooftop HVAC',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Water tank: NYC wooden rooftop tower ========================
//
// Built to match the user's manual fix in
// sedon-2026-06-10-04-10-31.sedon. Key economies vs the original:
//
//   1. ONE leg box geometry shared across all 4 legs via
//      `points/grid` + `geom/instance-on-points`.
//      Originally we declared 4 separate boxes — same shape, four
//      times the graph work and four times the GPU geometry.
//   2. ONE steel material shared by the leg group (was 4 identical
//      copies, one per leg).
//   3. ONE wood material shared by BOTH the tank body and the cap
//      (was 2 copies with identical values).
//
// The legs land at the corners of a 2 m × 2 m grid, base at Y=0,
// top at Y=2. The tank body sits CENTRED on the legs (cylinder
// translated up by 4 then down by 2 — a two-step lift the original
// fix kept in case future authoring wants to drive the second
// translate by something parametric).
export function buildWaterTankSubgraph(): SubgraphDef {
  const id = 'city-roof-water-tank';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 3 } });

  // ─── Shared materials ────────────────────────────────────────────
  // Wood — used by BOTH body and cap.
  const woodMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: {
      basecolor: [0.42, 0.27, 0.18, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  // Steel — used by the (single) leg-cluster entity.
  const steelMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: {
      basecolor: [0.25, 0.27, 0.30, 1],
      roughness: 0.45,
      metallic: 0.7,
    },
  });

  // ─── Legs: 1 box → grid-distribute → instance-on-points → lift → entity
  // grid-distribute(2×2, spacing 2) emits points at (±1, 0, ±1).
  // instance-on-points stamps the box at each. The combined geometry
  // gets translated up by 1 so the leg base sits at Y=0 (legs span
  // Y=0..2 since each box is height=2 centred at origin).
  const legBox = addNode(g, 'geom/box', {
    position: { x: COL, y: 0 },
    inputValues: { width: 0.18, height: 2, depth: 0.18 },
  });
  const legGrid = addNode(g, 'points/grid', {
    position: { x: COL, y: ROW * 0.6 },
    inputValues: { cols: 2, rows: 2, spacing: 2 },
  });
  const legInst = addNode(g, 'geom/instance-on-points', {
    position: { x: COL * 2, y: 0 },
    inputValues: { scale: 1 },
  });
  const legLift = addNode(g, 'geom/transform', {
    position: { x: COL * 3, y: 0 },
    inputValues: {
      translate: [0, 1, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const legEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 4, y: 0 },
  });
  addEdge(g, { node: legBox.id, socket: 'geometry' }, { node: legInst.id, socket: 'instance' });
  addEdge(g, { node: legGrid.id, socket: 'points' }, { node: legInst.id, socket: 'points' });
  addEdge(g, { node: legInst.id, socket: 'geometry' }, { node: legLift.id, socket: 'geometry' });
  addEdge(g, { node: legLift.id, socket: 'geometry' }, { node: legEnt.id, socket: 'geometry' });
  addEdge(g, { node: steelMat.id, socket: 'material' }, { node: legEnt.id, socket: 'material' });

  // ─── Body: wood cylinder, single +Y=2 lift so its centre sits at
  // Y=2 (the top of the legs). The .sedon fix had two chained
  // transforms (+4 then −2) — collapsed here to one.
  const bodyCyl = addNode(g, 'geom/cylinder', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { radius: 1.5, height: 4, segments: 16 },
  });
  const bodyLift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { translate: [0, 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const bodyEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: ROW * 2 },
  });
  addEdge(g, { node: bodyCyl.id, socket: 'geometry' }, { node: bodyLift.id, socket: 'geometry' });
  addEdge(g, { node: bodyLift.id, socket: 'geometry' }, { node: bodyEnt.id, socket: 'geometry' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: bodyEnt.id, socket: 'material' });

  // ─── Cap: shorter wider cylinder sharing the wood material.
  const capCyl = addNode(g, 'geom/cylinder', {
    position: { x: COL, y: ROW * 3.5 },
    inputValues: { radius: 1.6, height: 0.4, segments: 16 },
  });
  const capLift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 3.5 },
    inputValues: { translate: [0, 6, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const capEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 4, y: ROW * 3.5 },
  });
  addEdge(g, { node: capCyl.id, socket: 'geometry' }, { node: capLift.id, socket: 'geometry' });
  addEdge(g, { node: capLift.id, socket: 'geometry' }, { node: capEnt.id, socket: 'geometry' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: capEnt.id, socket: 'material' });

  // ─── Merge legs + body + cap.
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 4.5, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: legEnt.id,  socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: capEnt.id,  socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Rooftop water tank',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
