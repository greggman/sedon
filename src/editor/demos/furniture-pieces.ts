import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Hero furniture subgraphs. Each is a parametric piece — chair,
// sofa, table, bookshelf, filing cabinet — composed by referencing
// the texture and component subgraphs and arranging instances. All
// pieces are centred on the origin in X/Z; ground-relative in Y
// (bottom of legs / floor of cabinet at y = 0). The showroom main
// graph translates each piece into its room position.
//
// World units are metres. Dimensions follow standard furniture
// references (seat heights ~0.45 m, dining tables ~0.75 m, coffee
// tables ~0.40 m, etc.) so the relative scale reads correctly.
//
// Texture references: every piece instantiates whichever texture
// subgraph it needs (wood-texture / fabric-texture / metal-texture)
// once at the boundary of its build, threads basecolor + normal into
// a `material/pbr`, and reuses that material across all its
// components. So changing the wood palette inside `wood-texture`
// re-tints every wood surface in the room with no rewiring.

const COL = 280;
const ROW = 180;

// === Chair ============================================================
//
// Standard dining chair. 4 tapered wood legs at the corners of a
// 0.40 × 0.40 seat, with a 0.04m-thick wood seat on top and a
// 0.50m-tall back panel behind it. Total height ~0.95 m. Wood
// throughout (chair frame + seat + back).
export function buildChairSubgraph(): SubgraphDef {
  const id = 'chair';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 8, y: ROW * 2 },
  });

  // Texture + material. wood-texture defaults to oak-ish; passing
  // through unchanged here keeps that.
  const wood = addNode(g, 'subgraph/wood-texture', {
    position: { x: COL, y: 0 },
  });
  const woodMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.55, metallic: 0 },
  });

  // Leg subgraph (single leg at origin) — instanced at 4 corners.
  const leg = addNode(g, 'subgraph/tapered-leg', {
    position: { x: COL * 3, y: ROW },
    inputValues: { bottom_w: 0.04, height: 0.45, taper: 0.7 },
  });
  const corners = addNode(g, 'points/corners', {
    position: { x: COL * 3, y: ROW * 2 },
    // 0.40 spacing between leg centres on a 0.45m-wide seat — gives
    // ~2.5cm of overhang on each side.
    inputValues: { width: 0.40, depth: 0.40, inset: 0 },
  });
  const legs = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 4, y: ROW * 1.5 },
    inputValues: { scale: 1, align: true },
  });

  // Seat: 0.45 × 0.04 × 0.40 panel, lifted to sit on top of the legs.
  const seat = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 3.5 },
    inputValues: { width: 0.45, depth: 0.40, thickness: 0.04 },
  });
  // Legs end at y=0.45; seat is 0.04 thick, so its CENTRE sits at
  // y = 0.45 + 0.02 = 0.47.
  const seatLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { translate: [0, 0.47, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Back: 0.40 wide × 0.50 tall × 0.03 thin. wood-panel takes
  // `thickness` as the Y dimension, so a tall back is just a wood-
  // panel oriented with thickness > depth.
  const back = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 5 },
    inputValues: { width: 0.40, depth: 0.03, thickness: 0.50 },
  });
  // Back panel sits at the rear of the seat (z = -0.20 − 0.015 =
  // -0.215, so the panel's front face flushes with the back of the
  // seat) and centred vertically over the seat top:
  // y = 0.49 (seat top) + 0.25 (half panel height) = 0.74.
  const backLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 5 },
    inputValues: { translate: [0, 0.74, -0.215], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Merge legs + seat + back.
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 6, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });

  // Texture → material.
  addEdge(g, { node: wood.id, socket: 'basecolor' }, { node: woodMat.id, socket: 'basecolor' });
  addEdge(g, { node: wood.id, socket: 'normal' }, { node: woodMat.id, socket: 'normal' });

  // Material → every wood component.
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: leg.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: seat.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: back.id, socket: 'material' });

  // Leg instancing.
  addEdge(g, { node: leg.id, socket: 'scene' }, { node: legs.id, socket: 'instance' });
  addEdge(g, { node: corners.id, socket: 'points' }, { node: legs.id, socket: 'points' });

  // Seat / back placement.
  addEdge(g, { node: seat.id, socket: 'scene' }, { node: seatLift.id, socket: 'scene' });
  addEdge(g, { node: back.id, socket: 'scene' }, { node: backLift.id, socket: 'scene' });

  addEdge(g, { node: legs.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: seatLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: backLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Chair',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Table ============================================================
//
// Coffee table — wide top, four tapered wood legs. 1.20 × 0.60 top
// at h=0.40m (standard coffee-table height; raise to 0.75m to make
// it a dining table).
export function buildTableSubgraph(): SubgraphDef {
  const id = 'table';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 7, y: ROW * 2 },
  });

  const wood = addNode(g, 'subgraph/wood-texture', {
    position: { x: COL, y: 0 },
  });
  const woodMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.55, metallic: 0 },
  });

  const leg = addNode(g, 'subgraph/tapered-leg', {
    position: { x: COL * 3, y: ROW },
    inputValues: { bottom_w: 0.05, height: 0.40, taper: 0.7 },
  });
  // Coffee-table footprint is 1.20 × 0.60; inset legs by 8 cm so
  // they don't sit at the very edge.
  const corners = addNode(g, 'points/corners', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: { width: 1.20, depth: 0.60, inset: 0.08 },
  });
  const legs = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 4, y: ROW * 1.5 },
    inputValues: { scale: 1, align: true },
  });

  const top = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 3.5 },
    inputValues: { width: 1.20, depth: 0.60, thickness: 0.04 },
  });
  // Legs end at y=0.40; top is 0.04 thick → centre at y=0.42.
  const topLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { translate: [0, 0.42, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 6, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: wood.id, socket: 'basecolor' }, { node: woodMat.id, socket: 'basecolor' });
  addEdge(g, { node: wood.id, socket: 'normal' }, { node: woodMat.id, socket: 'normal' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: leg.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: top.id, socket: 'material' });

  addEdge(g, { node: leg.id, socket: 'scene' }, { node: legs.id, socket: 'instance' });
  addEdge(g, { node: corners.id, socket: 'points' }, { node: legs.id, socket: 'points' });
  addEdge(g, { node: top.id, socket: 'scene' }, { node: topLift.id, socket: 'scene' });
  addEdge(g, { node: legs.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: topLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Table',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Sofa =============================================================
//
// Three-seater sofa: 2.0 × 0.9 footprint, seat surface at h=0.40m
// (slightly lower than a chair for the "settle in" feel). A wood
// base + arms + 4 short legs frame the upholstery; the seat surface
// is 3 fabric cushions, with 3 back cushions behind them at h=0.6m.
//
// Lots of components — this is the longest hero piece. Each
// translates to its own position with `geom/transform`; we don't
// try to instance the cushions on a points-line because seat and
// back cushions differ in size.
export function buildSofaSubgraph(): SubgraphDef {
  const id = 'sofa';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 3 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 10, y: ROW * 3 },
  });

  // Materials: wood for frame/legs, fabric for cushions.
  const wood = addNode(g, 'subgraph/wood-texture', {
    position: { x: COL, y: 0 },
    // Walnut-ish for the sofa frame — darker than chair / table oak,
    // contrasts with the slate-blue fabric.
    inputValues: {
      color_dark: [0.10, 0.06, 0.04, 1],
      color_light: [0.32, 0.20, 0.12, 1],
    },
  });
  const woodMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.5, metallic: 0 },
  });
  const fabric = addNode(g, 'subgraph/fabric-texture', {
    position: { x: COL, y: ROW * 6 },
  });
  const fabricMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 6 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });

  // Wood base — 1.92 × 0.10 × 0.85 panel under the seat cushions.
  const base = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 0.5 },
    inputValues: { width: 1.92, depth: 0.85, thickness: 0.10 },
  });
  // Base centre at y = 0.20 + 0.05 = 0.25 (legs are 0.20 high).
  const baseLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 0.5 },
    inputValues: { translate: [0, 0.25, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Stubby legs. 0.20m tall (sofas sit lower than chairs).
  const leg = addNode(g, 'subgraph/tapered-leg', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { bottom_w: 0.05, height: 0.20, taper: 0.75 },
  });
  const legCorners = addNode(g, 'points/corners', {
    position: { x: COL * 3, y: ROW * 2.5 },
    inputValues: { width: 1.92, depth: 0.85, inset: 0.10 },
  });
  const legs = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { scale: 1, align: true },
  });

  // Arms — wood panels at left & right ends.
  const arm = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 3.5 },
    inputValues: { width: 0.10, depth: 0.85, thickness: 0.55 },
  });
  const armLeft = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3.3 },
    // x = -(base/2 + arm_w/2) = -(0.96 + 0.05) = -1.01; centre at
    // y = 0.20 + 0.275 = 0.575 (rests on the floor, top at 0.85m).
    inputValues: { translate: [-1.01, 0.575, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const armRight = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3.7 },
    inputValues: { translate: [1.01, 0.575, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Seat cushions (3 across). 0.62 × 0.15 × 0.78 each — slightly
  // larger than 1/3 of the 1.92 base so they spread visually beyond
  // the wood frame for a comfy look. Bottom of cushion sits on top
  // of the base (y = 0.30), centre at y = 0.30 + 0.075 = 0.375.
  const seatCushion = addNode(g, 'subgraph/cushion', {
    position: { x: COL * 3, y: ROW * 5 },
    inputValues: { width: 0.62, height: 0.15, depth: 0.78, bevel: 0.04 },
  });
  const seatPositions: Array<[number, number, number]> = [
    [-0.63, 0.375, 0],
    [0, 0.375, 0],
    [0.63, 0.375, 0],
  ];
  const seatTransforms = seatPositions.map((pos, i) =>
    addNode(g, 'scene/transform', {
      position: { x: COL * 4, y: ROW * (4.6 + i * 0.5) },
      inputValues: { translate: pos, rotate: [0, 0, 0], scale: [1, 1, 1] },
    }),
  );

  // Back cushions (3 across). Taller, thinner, behind the seat at
  // z=-0.30 (so they tuck against the back rail). Centre at
  // y = 0.45 (sit-on-seat) + 0.20 (half back height) = 0.65.
  const backCushion = addNode(g, 'subgraph/cushion', {
    position: { x: COL * 3, y: ROW * 7 },
    inputValues: { width: 0.62, height: 0.40, depth: 0.20, bevel: 0.04 },
  });
  const backPositions: Array<[number, number, number]> = [
    [-0.63, 0.65, -0.30],
    [0, 0.65, -0.30],
    [0.63, 0.65, -0.30],
  ];
  const backTransforms = backPositions.map((pos, i) =>
    addNode(g, 'scene/transform', {
      position: { x: COL * 4, y: ROW * (6.6 + i * 0.5) },
      inputValues: { translate: pos, rotate: [0, 0, 0], scale: [1, 1, 1] },
    }),
  );

  // 8-input merge: legs, base, armL, armR, 3 seat cushions, 3 back cushions.
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 8, y: ROW * 3 },
    extraInputs: Array.from({ length: 10 }, (_, i) => ({
      name: `scene_${i}`,
      type: 'Scene' as const,
      optional: true,
    })),
  });

  // Texture → material wiring.
  addEdge(g, { node: wood.id, socket: 'basecolor' }, { node: woodMat.id, socket: 'basecolor' });
  addEdge(g, { node: wood.id, socket: 'normal' }, { node: woodMat.id, socket: 'normal' });
  addEdge(g, { node: fabric.id, socket: 'basecolor' }, { node: fabricMat.id, socket: 'basecolor' });
  addEdge(g, { node: fabric.id, socket: 'normal' }, { node: fabricMat.id, socket: 'normal' });

  // Materials → components.
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: base.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: leg.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: arm.id, socket: 'material' });
  addEdge(g, { node: fabricMat.id, socket: 'material' }, { node: seatCushion.id, socket: 'material' });
  addEdge(g, { node: fabricMat.id, socket: 'material' }, { node: backCushion.id, socket: 'material' });

  // Geometry placement.
  addEdge(g, { node: base.id, socket: 'scene' }, { node: baseLift.id, socket: 'scene' });
  addEdge(g, { node: leg.id, socket: 'scene' }, { node: legs.id, socket: 'instance' });
  addEdge(g, { node: legCorners.id, socket: 'points' }, { node: legs.id, socket: 'points' });
  addEdge(g, { node: arm.id, socket: 'scene' }, { node: armLeft.id, socket: 'scene' });
  addEdge(g, { node: arm.id, socket: 'scene' }, { node: armRight.id, socket: 'scene' });
  for (const t of seatTransforms) {
    addEdge(g, { node: seatCushion.id, socket: 'scene' }, { node: t.id, socket: 'scene' });
  }
  for (const t of backTransforms) {
    addEdge(g, { node: backCushion.id, socket: 'scene' }, { node: t.id, socket: 'scene' });
  }

  // Merge all 10 inputs in order.
  const sources = [
    baseLift, legs, armLeft, armRight,
    ...seatTransforms,
    ...backTransforms,
  ];
  sources.forEach((node, i) => {
    addEdge(g, { node: node.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i}` });
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Sofa',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Bookshelf ========================================================
//
// 0.90 × 1.80 × 0.30 bookshelf — back panel + 2 sides + top + bottom
// + N shelves + books scattered across the shelves. The shelves are
// distributed via `points/line` + `instance-scene-on-points`;
// the books use a `points/grid` plus per-book color
// randomisation so each book in the row reads differently.
export function buildBookshelfSubgraph(): SubgraphDef {
  const id = 'bookshelf';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 3 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 10, y: ROW * 3 },
  });

  const W = 0.90;   // outer width
  const H = 1.80;   // outer height
  const D = 0.30;   // outer depth
  const T = 0.02;   // panel thickness
  const SHELVES = 4;
  const innerW = W - 2 * T;
  const innerH = H - 2 * T;
  const shelfTopGap = (innerH) / (SHELVES + 1);

  const wood = addNode(g, 'subgraph/wood-texture', {
    position: { x: COL, y: 0 },
    // Slightly lighter than chair-oak so the shelf reads as a
    // different wood species.
    inputValues: {
      color_dark: [0.22, 0.13, 0.07, 1],
      color_light: [0.60, 0.42, 0.26, 1],
    },
  });
  const woodMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.55, metallic: 0 },
  });

  // Back panel.
  const back = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 1 },
    inputValues: { width: W, depth: T, thickness: H },
  });
  const backLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 1 },
    inputValues: { translate: [0, H / 2, -D / 2 + T / 2], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Sides (left and right).
  const side = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: { width: T, depth: D, thickness: H },
  });
  const sideLeft = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { translate: [-W / 2 + T / 2, H / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const sideRight = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 2.5 },
    inputValues: { translate: [W / 2 - T / 2, H / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Top and bottom panels.
  const topBottom = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: { width: W, depth: D, thickness: T },
  });
  const topLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3 },
    inputValues: { translate: [0, H - T / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const bottomLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { translate: [0, T / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Internal shelves — distributed via points-line. Place SHELVES
  // points evenly between (just above bottom) and (just below top).
  const shelfPanel = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 4 },
    inputValues: { width: innerW, depth: D - 0.01, thickness: T },
  });
  const shelfLine = addNode(g, 'points/line', {
    position: { x: COL * 3, y: ROW * 5 },
    inputValues: {
      start: [0, T + shelfTopGap, 0],
      end: [0, H - T - shelfTopGap, 0],
      count: SHELVES,
    },
  });
  const shelves = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 4, y: ROW * 4.5 },
    // align=false: shelf panels are already Y-up (width along X, depth
    // along Z); with align=true on a Y-up point cloud, the basis
    // pointBasis derives swaps X↔Z (T=+Z, B=−X) and rotates the panel
    // 90° — invisible on square legs, very visible on non-square
    // shelves.
    inputValues: { scale: 1, align: false },
  });

  // Books — a row on the top inner shelf with cumulative-spacing
  // packing AND per-book variable size. Pipeline:
  //
  //   sizing      = points-line(count=BOOKS) — count carrier only
  //   widths      = random-float-cloud(min, max)  → per-book spine width
  //   heights     = random-float-cloud(min, max)  → per-book height
  //   depths      = random-float-cloud(min, max)  → per-book depth
  //   leftEdges   = accumulate(widths, exclusive) → left-edge X per book
  //   positions   = points-along-axis(origin, +X, leftEdges)
  //   per_scale   = vec3-cloud-from-floats(widths, heights, depths)
  //   per_tint    = random-vec3-cloud(min, max)   → per-book RGB
  //   books       = instance-scene-on-points(book, positions,
  //                   per_point_scale=per_scale,
  //                   per_point_tint=per_tint)
  //
  // The book subgraph is a unit cube with its bottom-back-LEFT corner
  // at origin, so per_point_scale ⊗ position places each book sitting
  // on the shelf with its left edge at the accumulated position. Books
  // pack tip-to-tail, sit on the shelf, back edges flush against the
  // bookshelf back panel.
  const BOOKS = 22;
  const book = addNode(g, 'subgraph/book', {
    position: { x: COL * 3, y: ROW * 6 },
    inputValues: {
      // Base colour tint; per_point_tint multiplies in. Light grey
      // makes the per-point tint values read as final colours.
      color: [1.0, 1.0, 1.0, 1],
    },
  });
  // Sizing points cloud — count carrier for the random clouds.
  // random-float-cloud / random-vec3-cloud both derive their count
  // from a PointCloud, so this is the one upstream chicken-and-egg
  // node. Positions don't matter.
  const bookSizing = addNode(g, 'points/line', {
    position: { x: COL, y: ROW * 6.6 },
    inputValues: { start: [0, 0, 0], end: [1, 0, 0], count: BOOKS },
  });
  const bookWidths = addNode(g, 'cloud/random-float', {
    position: { x: COL * 2, y: ROW * 5.6 },
    inputValues: { min: 0.025, max: 0.055, seed: 0.31 },
  });
  const bookHeights = addNode(g, 'cloud/random-float', {
    position: { x: COL * 2, y: ROW * 6.4 },
    inputValues: { min: 0.17, max: 0.24, seed: 0.52 },
  });
  const bookDepths = addNode(g, 'cloud/random-float', {
    position: { x: COL * 2, y: ROW * 7.2 },
    inputValues: { min: 0.13, max: 0.18, seed: 0.71 },
  });
  // exclusive scan: out[i] = sum(widths[0..i-1]) — exactly the
  // left-edge X coordinate of book i when packed tip-to-tail.
  const bookLeftEdges = addNode(g, 'cloud/accumulate', {
    position: { x: COL * 3, y: ROW * 6 },
    inputValues: { mode: 1 }, // 1 = exclusive (left edges)
  });
  // shelf-top Y for the SECOND-FROM-TOP cubby — books sit there.
  const topShelfY = H - T - shelfTopGap + T / 2;
  const bookLine = addNode(g, 'points/along-axis', {
    position: { x: COL * 4, y: ROW * 6 },
    inputValues: {
      // Origin = bottom-back-left of the leftmost book.
      //   x = inner-left wall + small margin (avoids touching the side).
      //   y = top surface of the shelf below this cubby.
      //   z = back of the shelf interior (so books' backs align there).
      origin: [-innerW / 2 + 0.02, topShelfY, -D / 2 + T + 0.005],
      axis: [1, 0, 0],
    },
  });
  // Zip widths/heights/depths into a Vec3Cloud — drives the per-book
  // (X, Y, Z) scale, which is what makes each book a different size.
  const bookScales = addNode(g, 'cloud/vec3-from-floats', {
    position: { x: COL * 3, y: ROW * 7.8 },
  });
  const bookColors = addNode(g, 'cloud/random-vec3', {
    position: { x: COL * 2, y: ROW * 8 },
    inputValues: {
      // Muted book-spine palette — leans toward reds / ochres /
      // navys, away from pure primaries.
      min: [0.15, 0.10, 0.08],
      max: [0.65, 0.50, 0.45],
      seed: 0.77,
    },
  });
  const books = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 6.5 },
    // align=false: books are already oriented (spine along +X,
    // height along +Y, depth along +Z). The Y-up normals on the
    // bookLine cloud would otherwise rotate them 90°.
    inputValues: { scale: 1, align: false },
  });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 8, y: ROW * 3 },
    extraInputs: Array.from({ length: 8 }, (_, i) => ({
      name: `scene_${i}`,
      type: 'Scene' as const,
      optional: true,
    })),
  });

  addEdge(g, { node: wood.id, socket: 'basecolor' }, { node: woodMat.id, socket: 'basecolor' });
  addEdge(g, { node: wood.id, socket: 'normal' }, { node: woodMat.id, socket: 'normal' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: back.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: side.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: topBottom.id, socket: 'material' });
  addEdge(g, { node: woodMat.id, socket: 'material' }, { node: shelfPanel.id, socket: 'material' });

  addEdge(g, { node: back.id, socket: 'scene' }, { node: backLift.id, socket: 'scene' });
  addEdge(g, { node: side.id, socket: 'scene' }, { node: sideLeft.id, socket: 'scene' });
  addEdge(g, { node: side.id, socket: 'scene' }, { node: sideRight.id, socket: 'scene' });
  addEdge(g, { node: topBottom.id, socket: 'scene' }, { node: topLift.id, socket: 'scene' });
  addEdge(g, { node: topBottom.id, socket: 'scene' }, { node: bottomLift.id, socket: 'scene' });
  addEdge(g, { node: shelfPanel.id, socket: 'scene' }, { node: shelves.id, socket: 'instance' });
  addEdge(g, { node: shelfLine.id, socket: 'points' }, { node: shelves.id, socket: 'points' });
  // Sizing → three random-size clouds + colour cloud.
  addEdge(g, { node: bookSizing.id, socket: 'points' }, { node: bookWidths.id, socket: 'points' });
  addEdge(g, { node: bookSizing.id, socket: 'points' }, { node: bookHeights.id, socket: 'points' });
  addEdge(g, { node: bookSizing.id, socket: 'points' }, { node: bookDepths.id, socket: 'points' });
  addEdge(g, { node: bookSizing.id, socket: 'points' }, { node: bookColors.id, socket: 'points' });
  // widths → exclusive scan → left-edge positions.
  addEdge(g, { node: bookWidths.id, socket: 'values' }, { node: bookLeftEdges.id, socket: 'values' });
  addEdge(g, { node: bookLeftEdges.id, socket: 'values' }, { node: bookLine.id, socket: 'offsets' });
  // Zip the three random sizes into a per_point_scale Vec3Cloud.
  addEdge(g, { node: bookWidths.id, socket: 'values' }, { node: bookScales.id, socket: 'x' });
  addEdge(g, { node: bookHeights.id, socket: 'values' }, { node: bookScales.id, socket: 'y' });
  addEdge(g, { node: bookDepths.id, socket: 'values' }, { node: bookScales.id, socket: 'z' });
  // Instance the unit-cube book at each position, scaled & tinted
  // per-point.
  addEdge(g, { node: book.id, socket: 'scene' }, { node: books.id, socket: 'instance' });
  addEdge(g, { node: bookLine.id, socket: 'points' }, { node: books.id, socket: 'points' });
  addEdge(g, { node: bookScales.id, socket: 'values' }, { node: books.id, socket: 'per_point_scale' });
  addEdge(g, { node: bookColors.id, socket: 'values' }, { node: books.id, socket: 'per_point_tint' });

  const sources = [backLift, sideLeft, sideRight, topLift, bottomLift, shelves, books];
  sources.forEach((node, i) => {
    addEdge(g, { node: node.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i}` });
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Bookshelf',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Filing cabinet ===================================================
//
// 0.45 × 1.30 × 0.55 metal cabinet, 4 drawers stacked. The drawer
// subgraph already handles the paneled-face + pull; this hero piece
// instances it 4 times via points-line. The cabinet body is just a
// metal box behind the drawer faces — it'd be hidden in a real
// install but the demo's free-floating piece needs SOMETHING behind
// the drawer fronts so the silhouette reads cabinet-shaped from any
// angle.
export function buildFilingCabinetSubgraph(): SubgraphDef {
  const id = 'filing-cabinet';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 8, y: ROW * 2 },
  });

  const W = 0.45;
  const H = 1.30;
  const D = 0.55;
  const DRAWERS = 4;
  const drawerH = H / DRAWERS;

  const metal = addNode(g, 'subgraph/metal-texture', {
    position: { x: COL, y: 0 },
  });
  const metalMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.3, metallic: 0.85 },
  });

  // Cabinet body (slightly smaller than the drawer footprint so it's
  // hidden when viewed from the front).
  const body = addNode(g, 'subgraph/wood-panel', {
    position: { x: COL * 3, y: ROW * 1 },
    inputValues: { width: W - 0.04, depth: D - 0.02, thickness: H - 0.01 },
  });
  const bodyLift = addNode(g, 'scene/transform', {
    position: { x: COL * 4, y: ROW * 1 },
    inputValues: { translate: [0, H / 2, -0.01], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });

  // Drawer subgraph; instanced 4 times along Y. drawer's body is
  // centred on origin so its base is at y = -drawerH/2.
  const drawer = addNode(g, 'subgraph/drawer', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: { width: W, height: drawerH - 0.005, depth: D },
  });
  // Distribute drawer copies along Y. First drawer's centre at
  // drawerH/2; last drawer's centre at H - drawerH/2.
  const drawerLine = addNode(g, 'points/line', {
    position: { x: COL * 3, y: ROW * 4 },
    inputValues: {
      start: [0, drawerH / 2, 0],
      end: [0, H - drawerH / 2, 0],
      count: DRAWERS,
    },
  });
  const drawers = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { scale: 1, align: true },
  });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 6, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: metal.id, socket: 'basecolor' }, { node: metalMat.id, socket: 'basecolor' });
  addEdge(g, { node: metal.id, socket: 'normal' }, { node: metalMat.id, socket: 'normal' });
  addEdge(g, { node: metalMat.id, socket: 'material' }, { node: body.id, socket: 'material' });
  addEdge(g, { node: metalMat.id, socket: 'material' }, { node: drawer.id, socket: 'material' });

  addEdge(g, { node: body.id, socket: 'scene' }, { node: bodyLift.id, socket: 'scene' });
  addEdge(g, { node: drawer.id, socket: 'scene' }, { node: drawers.id, socket: 'instance' });
  addEdge(g, { node: drawerLine.id, socket: 'points' }, { node: drawers.id, socket: 'points' });

  addEdge(g, { node: bodyLift.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: drawers.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Filing Cabinet',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
