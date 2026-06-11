import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Modular parametric office, Houdini-style. Four subgraphs:
//
//   1. `office-ground-floor` — the 5 m storefront band (one box).
//   2. `office-upper-floor`  — one 3.5 m floor of the body
//                              (one box; instanced N times in the
//                              assembled subgraph via scene/instance-
//                              on-points so every floor shares ONE
//                              (geometry, material) pair).
//   3. `office-roof-cap`     — the 0.6 m parapet PLUS rooftop fittings
//                              (HVAC + water-tank scatters on the
//                              parapet's +Y face).
//   4. `office-assembled`    — composes the three modules vertically
//                              (ground at Y=0..5, body at Y=5..5+N×3.5,
//                              roof at Y=top), then adds the facade
//                              decorations the city scene needs
//                              (awnings, side-wall AC, fire escape).
//
// Authoring conventions match the fire-escape decomposition: modules
// take only intrinsic dimensions (width, depth — not num_floors), the
// assembled subgraph owns all the math + composition. Every subgraph
// outputs a single `scene: Scene` so the wrappers compose with
// `scene/merge` like any other scene-emitting node.

const COL = 240;
const ROW = 160;

// Shared 7-row × 1-col upper-floor window texture. One row of windows
// per floor: stacking N floor modules stacks N rows of windows
// vertically without the texture-stretch the original parametric
// office had (a single [7, 7] grid spread over a num_floors-tall body
// scaled visibly differently for short vs tall buildings; per-floor
// modules sidestep that entirely).
const UPPER_FLOOR_DIVISIONS: [number, number] = [7, 1];
const UPPER_FLOOR_HEIGHT = 3.5;
const GROUND_FLOOR_HEIGHT = 5;
const ROOF_CAP_HEIGHT = 0.6;

// ────────────────────────────────────────────────────────────────────
// Module 1: one upper floor (the 3.5 m unit).
// ────────────────────────────────────────────────────────────────────

export function buildOfficeUpperFloorSubgraph(): SubgraphDef {
  const id = 'office-upper-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Window grid: light concrete mullions, dark glass bg. One row tall
  // so stacking N modules in the assembly produces N visually
  // distinct rows of windows (no texture stretch).
  const windowTex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],
      bg: [0.12, 0.16, 0.22, 1],
      divisions: UPPER_FLOOR_DIVISIONS,
      line_width: 0.10,
      resolution: 256,
    },
  });
  // Emissive copy with windows-as-lit, mullions-as-dark. Pushed into
  // HDR by emissive_intensity so the bloom pass picks it up.
  const lightTex = addNode(g, 'tex/grid', {
    position: { x: 0, y: ROW },
    inputValues: {
      fg: [0, 0, 0, 1],
      bg: [1.0, 0.78, 0.45, 1],
      divisions: UPPER_FLOOR_DIVISIONS,
      line_width: 0.10,
      resolution: 256,
    },
  });

  // Box authored with its centre at the origin (the assembled subgraph
  // places each instance at the right Y). Width / depth come from the
  // surface inputs; height is baked at 3.5 m.
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 20, height: UPPER_FLOOR_HEIGHT, depth: 25 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.4, metallic: 0.2, emissive_intensity: 2 },
  });
  addEdge(g, { node: windowTex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  addEdge(g, { node: lightTex.id,  socket: 'texture' }, { node: mat.id, socket: 'emissive' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office · upper floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 20 },
      { name: 'depth', type: 'Float', default: 25 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 2: ground floor (the 5 m storefront band).
// ────────────────────────────────────────────────────────────────────

export function buildOfficeGroundFloorSubgraph(): SubgraphDef {
  const id = 'office-ground-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Storefront grid: one tall row of big windows (10 × 1).
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],
      bg: [0.10, 0.14, 0.20, 1],
      divisions: [10, 1],
      line_width: 0.08,
      resolution: 256,
    },
  });

  // Box: width × depth × 5 m, centred at local Y=2.5 so the base sits
  // at Y=0 and the top at Y=5 — same convention the original
  // parametric office used. transform-geometry handles the lift.
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { width: 22, height: GROUND_FLOOR_HEIGHT, depth: 25 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: {
      translate: [0, GROUND_FLOOR_HEIGHT / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });

  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2.5 },
    inputValues: { roughness: 0.45, metallic: 0.15 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office · ground floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 21 },
      { name: 'depth', type: 'Float', default: 26 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 3: roof cap (parapet + HVAC + water-tank scatter).
// ────────────────────────────────────────────────────────────────────
//
// Authored at LOCAL Y=0 with the parapet's CENTRE at Y=0 (it spans
// Y=-0.3..0.3). The assembled subgraph places the whole cap at world
// Y = (ground top) + (body top) + half the cap so the parapet sits
// directly on the body's top face. Internal rooftop scatters use the
// SAME width-seeded random patterns the original parametric office did
// — same look on the assembled building.

export function buildOfficeRoofCapSubgraph(): SubgraphDef {
  const id = 'office-roof-cap';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 5 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 6, y: ROW * 5 } });

  // Parapet: 0.6 m concrete band sitting on the body. Centre at
  // Y=0 (local). The assembled subgraph applies the world-Y lift.
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 0 },
    inputValues: { width: 21, height: ROOF_CAP_HEIGHT, depth: 26 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: { basecolor: [0.78, 0.78, 0.80, 1], roughness: 0.7, metallic: 0.05 },
  });
  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 0 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });

  // ── HVAC: 4×3 = 12 candidate slots on the parapet's +Y face,
  // ~45% activated by a cloud-step on a width-seeded random. Same
  // pattern logic the original parametric office had.
  const hvacPts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: {
      axis: [0, 1, 0],
      height: ROOF_CAP_HEIGHT, // implicit box matches the parapet thickness
      cols: 4,
      rows: 3,
      inset: 3,
      offset: 0,
    },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: hvacPts.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: hvacPts.id, socket: 'depth' });
  const hvacRand = addNode(g, 'cloud/random-float', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: { min: 0, max: 1, seed: 0 },
  });
  addEdge(g, { node: hvacPts.id, socket: 'points' }, { node: hvacRand.id, socket: 'points' });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: hvacRand.id, socket: 'seed' });
  const hvacMask = addNode(g, 'cloud/step', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { threshold: 0.55, invert: false },
  });
  addEdge(g, { node: hvacRand.id, socket: 'values' }, { node: hvacMask.id, socket: 'values' });
  const hvacWrap = addNode(g, 'subgraph/city-roof-hvac', { position: { x: COL * 2, y: ROW * 2.5 } });
  const hvacScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 2 },
    inputValues: { scale: 1, align: true, seed: 0 },
  });
  addEdge(g, { node: hvacPts.id,  socket: 'points' },           { node: hvacScatter.id, socket: 'points' });
  addEdge(g, { node: hvacMask.id, socket: 'mask' },             { node: hvacScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: hvacWrap.id, socket: 'scene' },            { node: hvacScatter.id, socket: 'instance' });
  addEdge(g, { node: inputNode.id, socket: 'width' },           { node: hvacScatter.id, socket: 'seed' });

  // ── Water tanks: 2×2 = 4 candidate slots, separate seed offset
  // from HVAC so the patterns aren't correlated.
  const tankPts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: {
      axis: [0, 1, 0],
      height: ROOF_CAP_HEIGHT,
      cols: 2,
      rows: 2,
      inset: 4,
      offset: 0,
    },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: tankPts.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: tankPts.id, socket: 'depth' });
  const tankSeed = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 2.7 },
    inputValues: { b: 100 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: tankSeed.id, socket: 'a' });
  const tankRand = addNode(g, 'cloud/random-float', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: { min: 0, max: 1, seed: 0 },
  });
  addEdge(g, { node: tankPts.id, socket: 'points' }, { node: tankRand.id, socket: 'points' });
  addEdge(g, { node: tankSeed.id, socket: 'result' }, { node: tankRand.id, socket: 'seed' });
  const tankMask = addNode(g, 'cloud/step', {
    position: { x: COL * 4, y: ROW * 3 },
    inputValues: { threshold: 0.6, invert: false },
  });
  addEdge(g, { node: tankRand.id, socket: 'values' }, { node: tankMask.id, socket: 'values' });
  const tankWrap = addNode(g, 'subgraph/city-roof-water-tank', { position: { x: COL * 2, y: ROW * 3.5 } });
  const tankScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 3 },
    inputValues: { scale: 1, align: true, seed: 0 },
  });
  addEdge(g, { node: tankPts.id,  socket: 'points' },         { node: tankScatter.id, socket: 'points' });
  addEdge(g, { node: tankMask.id, socket: 'mask' },           { node: tankScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tankWrap.id, socket: 'scene' },          { node: tankScatter.id, socket: 'instance' });
  addEdge(g, { node: tankSeed.id, socket: 'result' },         { node: tankScatter.id, socket: 'seed' });

  const merge = addNode(g, 'scene/merge', { position: { x: COL * 5, y: ROW * 0.5 } });
  addEdge(g, { node: ent.id,         socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: hvacScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: tankScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office · roof cap',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 21 },
      { name: 'depth', type: 'Float', default: 26 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Assembly: composes the three modules + facade decorations.
// ────────────────────────────────────────────────────────────────────
//
// Replaces the old `city-bldg-parametric-office`. Same surface inputs
// (width, depth, num_floors, fire_escape_threshold) so the city +
// single-building demos can keep their wiring unchanged — only the
// referenced kind changes from `subgraph/city-bldg-parametric-office`
// to `subgraph/office-assembled`.

export function buildOfficeAssembledSubgraph(): SubgraphDef {
  const id = 'office-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 8 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 8, y: ROW * 8 } });

  // ── Derived parametric values ─────────────────────────────────────
  // bodyHeight        = num_floors * UPPER_FLOOR_HEIGHT
  // bodyTopY          = GROUND_FLOOR_HEIGHT + bodyHeight
  // setback_width     = width - 1   (upper-floor wraps get a 0.5 m
  // setback_depth     = depth - 1    setback on each side)
  // lastFloorCentreY  = bodyTopY - UPPER_FLOOR_HEIGHT / 2
  // roofCapY          = bodyTopY + ROOF_CAP_HEIGHT / 2
  // bodyCentreY       = GROUND_FLOOR_HEIGHT + bodyHeight / 2
  const bodyHeight = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 0 },
    inputValues: { b: UPPER_FLOOR_HEIGHT },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: bodyHeight.id, socket: 'a' });

  const bodyTopY = addNode(g, 'math/add', {
    position: { x: COL * 2, y: ROW * 0 },
    inputValues: { b: GROUND_FLOOR_HEIGHT },
  });
  addEdge(g, { node: bodyHeight.id, socket: 'result' }, { node: bodyTopY.id, socket: 'a' });

  const lastFloorCentreY = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 0 },
    inputValues: { b: -UPPER_FLOOR_HEIGHT / 2 },
  });
  addEdge(g, { node: bodyTopY.id, socket: 'result' }, { node: lastFloorCentreY.id, socket: 'a' });

  const roofCapY = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 1 },
    inputValues: { b: ROOF_CAP_HEIGHT / 2 },
  });
  addEdge(g, { node: bodyTopY.id, socket: 'result' }, { node: roofCapY.id, socket: 'a' });

  const halfBody = addNode(g, 'math/multiply', {
    position: { x: COL * 2, y: ROW * 1 },
    inputValues: { b: 0.5 },
  });
  addEdge(g, { node: bodyHeight.id, socket: 'result' }, { node: halfBody.id, socket: 'a' });
  const bodyCentreY = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { b: GROUND_FLOOR_HEIGHT },
  });
  addEdge(g, { node: halfBody.id, socket: 'result' }, { node: bodyCentreY.id, socket: 'a' });

  const setbackWidth = addNode(g, 'math/add', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { b: -1 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: setbackWidth.id, socket: 'a' });
  const setbackDepth = addNode(g, 'math/add', {
    position: { x: COL, y: ROW * 2.5 },
    inputValues: { b: -1 },
  });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: setbackDepth.id, socket: 'a' });

  // ── Ground floor module ───────────────────────────────────────────
  const groundWrap = addNode(g, 'subgraph/office-ground-floor', {
    position: { x: COL * 2, y: ROW * 3 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: groundWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: groundWrap.id, socket: 'depth' });

  // ── Upper-floor module instanced N times via points/line ──────────
  // points-line gives `num_floors` evenly-spaced points along Y from
  // (0, firstCentreY, 0) to (0, lastCentreY, 0). First floor centred
  // at GROUND_FLOOR_HEIGHT + UPPER_FLOOR_HEIGHT/2 (= 6.75 for
  // UPPER_FLOOR_HEIGHT=3.5); subsequent floors stack upward.
  const firstFloorCentreY = GROUND_FLOOR_HEIGHT + UPPER_FLOOR_HEIGHT / 2;
  const startPt = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 4 },
    inputValues: { x: 0, y: firstFloorCentreY, z: 0 },
  });
  const endPt = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 4 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: lastFloorCentreY.id, socket: 'result' }, { node: endPt.id, socket: 'y' });

  const floorPts = addNode(g, 'points/line', {
    position: { x: COL * 5, y: ROW * 4 },
    inputValues: { start: [0, firstFloorCentreY, 0], end: [0, 27.75, 0], count: 7 },
  });
  addEdge(g, { node: startPt.id, socket: 'value' }, { node: floorPts.id, socket: 'start' });
  addEdge(g, { node: endPt.id,   socket: 'value' }, { node: floorPts.id, socket: 'end' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: floorPts.id, socket: 'count' });

  const upperWrap = addNode(g, 'subgraph/office-upper-floor', {
    position: { x: COL * 2, y: ROW * 5 },
  });
  addEdge(g, { node: setbackWidth.id, socket: 'result' }, { node: upperWrap.id, socket: 'width' });
  addEdge(g, { node: setbackDepth.id, socket: 'result' }, { node: upperWrap.id, socket: 'depth' });

  const floorScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 6, y: ROW * 4.5 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: floorPts.id,  socket: 'points' },   { node: floorScatter.id, socket: 'points' });
  addEdge(g, { node: upperWrap.id, socket: 'scene' },    { node: floorScatter.id, socket: 'instance' });

  // ── Roof cap module ───────────────────────────────────────────────
  const roofWrap = addNode(g, 'subgraph/office-roof-cap', {
    position: { x: COL * 2, y: ROW * 6 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: roofWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: roofWrap.id, socket: 'depth' });
  const roofLiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 6 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: roofCapY.id, socket: 'result' }, { node: roofLiftVec.id, socket: 'y' });
  const roofShift = addNode(g, 'scene/transform', {
    position: { x: COL * 5, y: ROW * 6 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: roofWrap.id,    socket: 'scene' }, { node: roofShift.id, socket: 'scene' });
  addEdge(g, { node: roofLiftVec.id, socket: 'value' }, { node: roofShift.id, socket: 'translate' });

  // ── Awnings on -X (street) face at ground-floor mid-height ────────
  const awningPts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 7 },
    inputValues: { axis: [-1, 0, 0], height: GROUND_FLOOR_HEIGHT, cols: 4, rows: 1, inset: 1.5, offset: 0.05 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: awningPts.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: awningPts.id, socket: 'depth' });
  const awningSeed = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 6.7 },
    inputValues: { b: 200 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: awningSeed.id, socket: 'a' });
  const awningRand = addNode(g, 'cloud/random-float', {
    position: { x: COL * 3, y: ROW * 7 },
    inputValues: { min: 0, max: 1, seed: 0 },
  });
  addEdge(g, { node: awningPts.id,  socket: 'points' },  { node: awningRand.id, socket: 'points' });
  addEdge(g, { node: awningSeed.id, socket: 'result' },  { node: awningRand.id, socket: 'seed' });
  const awningMask = addNode(g, 'cloud/step', {
    position: { x: COL * 4, y: ROW * 7 },
    inputValues: { threshold: 0.4, invert: false },
  });
  addEdge(g, { node: awningRand.id, socket: 'values' }, { node: awningMask.id, socket: 'values' });
  const awningTint = addNode(g, 'cloud/random-vec3', {
    position: { x: COL * 3, y: ROW * 7.3 },
    inputValues: { min: [0.4, 0.4, 0.4], max: [1, 1, 1], seed: 0 },
  });
  addEdge(g, { node: awningPts.id,  socket: 'points' },  { node: awningTint.id, socket: 'points' });
  addEdge(g, { node: awningSeed.id, socket: 'result' },  { node: awningTint.id, socket: 'seed' });
  const awningWrap = addNode(g, 'subgraph/city-storefront-awning', { position: { x: COL * 2, y: ROW * 7.5 } });
  const awningScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 7 },
    inputValues: { scale: 1, align: true, seed: 0 },
  });
  addEdge(g, { node: awningPts.id,  socket: 'points' },         { node: awningScatter.id, socket: 'points' });
  addEdge(g, { node: awningMask.id, socket: 'mask' },           { node: awningScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: awningTint.id, socket: 'values' },         { node: awningScatter.id, socket: 'per_point_tint' });
  addEdge(g, { node: awningWrap.id, socket: 'scene' },          { node: awningScatter.id, socket: 'instance' });
  // Awning grid emits at face-centre Y=0; lift to ground-floor mid-Y.
  const awningLift = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 7 },
    inputValues: { translate: [0, GROUND_FLOOR_HEIGHT / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: awningScatter.id, socket: 'scene' }, { node: awningLift.id, socket: 'scene' });

  // ── Side-wall AC on ±Z faces, body region ─────────────────────────
  function addWallAcScatter(
    axis: [number, number, number],
    seedOffset: number,
    yOff: number,
  ): ReturnType<typeof addNode> {
    const pts = addNode(g, 'points/box-face', {
      position: { x: COL * 2, y: yOff },
      inputValues: { axis, height: 1, cols: 2, rows: 5, inset: 1, offset: 0.05 },
    });
    addEdge(g, { node: inputNode.id, socket: 'width' },  { node: pts.id, socket: 'width' });
    addEdge(g, { node: inputNode.id, socket: 'depth' },  { node: pts.id, socket: 'depth' });
    addEdge(g, { node: bodyHeight.id, socket: 'result' }, { node: pts.id, socket: 'height' });

    const seed = addNode(g, 'math/add', {
      position: { x: COL * 3, y: yOff - ROW * 0.3 },
      inputValues: { b: seedOffset },
    });
    addEdge(g, { node: inputNode.id, socket: 'width' }, { node: seed.id, socket: 'a' });
    const rand = addNode(g, 'cloud/random-float', {
      position: { x: COL * 3, y: yOff },
      inputValues: { min: 0, max: 1, seed: 0 },
    });
    addEdge(g, { node: pts.id,  socket: 'points' }, { node: rand.id, socket: 'points' });
    addEdge(g, { node: seed.id, socket: 'result' }, { node: rand.id, socket: 'seed' });
    const mask = addNode(g, 'cloud/step', {
      position: { x: COL * 4, y: yOff },
      inputValues: { threshold: 0.5, invert: false },
    });
    addEdge(g, { node: rand.id, socket: 'values' }, { node: mask.id, socket: 'values' });

    const wrap = addNode(g, 'subgraph/city-wall-ac', { position: { x: COL * 2, y: yOff + ROW * 0.5 } });
    const scatter = addNode(g, 'scene/instance-on-points', {
      position: { x: COL * 5, y: yOff },
      inputValues: { scale: 1, align: true, seed: 0 },
    });
    addEdge(g, { node: pts.id,  socket: 'points' }, { node: scatter.id, socket: 'points' });
    addEdge(g, { node: mask.id, socket: 'mask' },   { node: scatter.id, socket: 'per_point_active' });
    addEdge(g, { node: wrap.id, socket: 'scene' },  { node: scatter.id, socket: 'instance' });

    // Lift scatter up by bodyCentreY so the grid (centred at y=0)
    // lands at the body's vertical centre.
    const liftVec = addNode(g, 'math/vec3-from-floats', {
      position: { x: COL * 5, y: yOff + ROW * 0.3 },
      inputValues: { x: 0, y: 0, z: 0 },
    });
    addEdge(g, { node: bodyCentreY.id, socket: 'result' }, { node: liftVec.id, socket: 'y' });
    const lift = addNode(g, 'scene/transform', {
      position: { x: COL * 6, y: yOff },
      inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
    addEdge(g, { node: scatter.id, socket: 'scene' }, { node: lift.id, socket: 'scene' });
    addEdge(g, { node: liftVec.id, socket: 'value' }, { node: lift.id, socket: 'translate' });
    return lift;
  }
  const acPlusZ  = addWallAcScatter([0, 0,  1], 300, ROW * 8);
  const acMinusZ = addWallAcScatter([0, 0, -1], 400, ROW * 9);

  // ── Fire escape on +Z wall, per-building random gating ────────────
  const firePts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 10 },
    inputValues: { axis: [0, 0, 1], height: 1, cols: 1, rows: 1, inset: 0, offset: 0.05 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: firePts.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: firePts.id, socket: 'depth' });
  const fireSeed = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 9.7 },
    inputValues: { b: 500 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: fireSeed.id, socket: 'a' });
  const fireRand = addNode(g, 'cloud/random-float', {
    position: { x: COL * 3, y: ROW * 10 },
    inputValues: { min: 0, max: 1, seed: 0 },
  });
  addEdge(g, { node: firePts.id,  socket: 'points' }, { node: fireRand.id, socket: 'points' });
  addEdge(g, { node: fireSeed.id, socket: 'result' }, { node: fireRand.id, socket: 'seed' });
  const fireMask = addNode(g, 'cloud/step', {
    position: { x: COL * 4, y: ROW * 10 },
    inputValues: { threshold: 0.4, invert: false },
  });
  addEdge(g, { node: fireRand.id, socket: 'values' }, { node: fireMask.id, socket: 'values' });
  addEdge(g, { node: inputNode.id, socket: 'fire_escape_threshold' }, { node: fireMask.id, socket: 'threshold' });

  const fireWrap = addNode(g, 'subgraph/fire-escape-assembled', {
    position: { x: COL * 2, y: ROW * 10.5 },
    inputValues: { floor_height: 3.5, bottom_height: 2, top_height: 2 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: fireWrap.id, socket: 'num_floors' });
  const fireScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 10 },
    inputValues: { scale: 1, align: true, seed: 0 },
  });
  addEdge(g, { node: firePts.id,  socket: 'points' }, { node: fireScatter.id, socket: 'points' });
  addEdge(g, { node: fireMask.id, socket: 'mask' },   { node: fireScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: fireWrap.id, socket: 'scene' },  { node: fireScatter.id, socket: 'instance' });
  // Lift so the fire-escape's local Z=0 lands at world Y=ground-top.
  const fireLift = addNode(g, 'scene/transform', {
    position: { x: COL * 6, y: ROW * 10 },
    inputValues: { translate: [0, GROUND_FLOOR_HEIGHT, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: fireScatter.id, socket: 'scene' }, { node: fireLift.id, socket: 'scene' });

  // ── Merge everything ──────────────────────────────────────────────
  const merge = addNode(g, 'scene/merge', { position: { x: COL * 7, y: ROW * 5 } });
  addEdge(g, { node: groundWrap.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: floorScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: roofShift.id,    socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: awningLift.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: acPlusZ.id,      socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: acMinusZ.id,     socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: fireLift.id,     socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office · assembled',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 21 },
      { name: 'depth',      type: 'Float', default: 26 },
      { name: 'num_floors', type: 'Float', default: 7 },
      // Fire-escape activation threshold (random-float-cloud →
      // cloud-step). 0.4 → ~60% activation (city default). -1 forces
      // every building to render a fire escape (dev demos).
      { name: 'fire_escape_threshold', type: 'Float', default: 0.4 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
