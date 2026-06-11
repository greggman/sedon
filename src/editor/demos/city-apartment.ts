import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Modular parametric apartment, Houdini-style. Same decomposition
// pattern as city-office:
//
//   1. `apartment-ground-floor` — 3.5 m entrance band (one box).
//   2. `apartment-upper-floor`  — one 3.0 m residential floor
//                                 (one box; instanced N times in the
//                                 assembled subgraph via
//                                 scene/instance-on-points so every
//                                 floor shares ONE (geometry, material)
//                                 pair).
//   3. `apartment-roof-cap`     — 0.4 m beige parapet + sparse rooftop
//                                 water tanks (no HVAC — apartments
//                                 read as residential, not commercial).
//   4. `apartment-assembled`    — composes the three modules vertically.
//                                 No setback (the body matches the
//                                 ground floor width — distinct
//                                 silhouette from the office's
//                                 setback look). No awnings, no wall
//                                 signs, no side AC — apartments stay
//                                 visually quieter than offices.
//
// Visual differentiation from `office-assembled`:
//   • Warm beige concrete frames vs the office's cool blue/grey glass
//   • Shorter floors (3.0 m vs 3.5 m) → more floors per building
//     height, denser horizontal banding
//   • Denser window grid per floor (8 cols vs 7) → tighter, smaller
//     windows that read as residential
//   • Flat silhouette (no setback) → distinct profile at silhouette
//     distance
//   • No HDR-glow window lights → reads matte at dusk while offices
//     bloom
//
// Surface contract identical to office-assembled (width, depth,
// num_floors → scene) so the city's per-lot bridge can dispatch
// between the two via scene/switch without per-variant wiring.

const COL = 240;
const ROW = 160;

const UPPER_FLOOR_DIVISIONS: [number, number] = [8, 1];
const UPPER_FLOOR_HEIGHT = 3.0;
const GROUND_FLOOR_HEIGHT = 3.5;
const ROOF_CAP_HEIGHT = 0.4;

const BEIGE_CONCRETE: [number, number, number, number] = [0.86, 0.78, 0.66, 1];
const APARTMENT_GLASS:   [number, number, number, number] = [0.20, 0.22, 0.24, 1];
const GROUND_PANEL_DARK: [number, number, number, number] = [0.30, 0.30, 0.32, 1];

// ────────────────────────────────────────────────────────────────────
// Module 1: one upper floor (the 3.0 m residential unit).
// ────────────────────────────────────────────────────────────────────

export function buildApartmentUpperFloorSubgraph(): SubgraphDef {
  const id = 'apartment-upper-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Single dense row of small windows in beige concrete frames.
  // line_width is wider than the office (0.20 vs 0.10) so the
  // concrete frame reads as a chunky residential window surround
  // instead of a thin office mullion.
  const windowTex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: BEIGE_CONCRETE,
      bg: APARTMENT_GLASS,
      divisions: UPPER_FLOOR_DIVISIONS,
      line_width: 0.20,
      resolution: 256,
    },
  });

  // Box authored centred at the local origin; the assembled subgraph
  // places each instance at the right Y.
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 18, height: UPPER_FLOOR_HEIGHT, depth: 22 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });

  // Matte residential surface: higher roughness, low metallic, no
  // emissive (apartments don't glow at dusk in this pass — that's
  // what makes them read as residential vs commercial).
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { roughness: 0.55, metallic: 0.05 },
  });
  addEdge(g, { node: windowTex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Apartment · upper floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 18 },
      { name: 'depth', type: 'Float', default: 22 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 2: ground floor (the 3.5 m entrance band).
// ────────────────────────────────────────────────────────────────────

export function buildApartmentGroundFloorSubgraph(): SubgraphDef {
  const id = 'apartment-ground-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW * 2 } });

  // Entrance band: a single horizontal strip of darker panels with
  // beige concrete frames. Reads as the residential lobby band — not
  // a commercial storefront. 8 columns × 1 row matches the upper-
  // floor texture's horizontal density so vertical alignment looks
  // intentional.
  const tex = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: BEIGE_CONCRETE,
      bg: GROUND_PANEL_DARK,
      divisions: [8, 1],
      line_width: 0.15,
      resolution: 256,
    },
  });

  // Box: width × depth × 3.5 m, centred at local Y=1.75 (so base at
  // Y=0, top at Y=3.5).
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 1.5 },
    inputValues: { width: 18, height: GROUND_FLOOR_HEIGHT, depth: 22 },
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
    inputValues: { roughness: 0.6, metallic: 0.03 },
  });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });

  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 2 } });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Apartment · ground floor',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 18 },
      { name: 'depth', type: 'Float', default: 22 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Module 3: roof cap (flat beige parapet + sparse water tanks).
// ────────────────────────────────────────────────────────────────────
//
// Authored at LOCAL Y=0 with the parapet's CENTRE at Y=0 (it spans
// Y=-0.2..0.2). The assembled subgraph places the whole cap at world
// Y so the parapet sits on the body's top face.

export function buildApartmentRoofCapSubgraph(): SubgraphDef {
  const id = 'apartment-roof-cap';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 6, y: ROW * 3 } });

  // Beige concrete parapet — a 0.4 m band the same width / depth as
  // the building body (no setback, no overhang). Solid material
  // (no texture node, no window grid).
  const box = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 0 },
    inputValues: { width: 18, height: ROOF_CAP_HEIGHT, depth: 22 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: box.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: box.id, socket: 'depth' });
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: { basecolor: BEIGE_CONCRETE, roughness: 0.7, metallic: 0.05 },
  });
  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW * 0 } });
  addEdge(g, { node: box.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });

  // ── Water tanks: 2×2 = 4 candidate slots, sparse activation.
  // Same `subgraph/city-roof-water-tank` the office uses — keeping
  // the rooftop fitting library shared (one wrap, two buildings).
  // Seed is offset from office's tank seed (100) so the apartment's
  // pattern decorrelates from neighbouring offices.
  const tankPts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 2 },
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
    position: { x: COL * 3, y: ROW * 1.7 },
    inputValues: { b: 700 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: tankSeed.id, socket: 'a' });
  const tankRand = addNode(g, 'cloud/random-float', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: { min: 0, max: 1, seed: 0 },
  });
  addEdge(g, { node: tankPts.id,  socket: 'points' }, { node: tankRand.id, socket: 'points' });
  addEdge(g, { node: tankSeed.id, socket: 'result' }, { node: tankRand.id, socket: 'seed' });
  const tankMask = addNode(g, 'cloud/step', {
    position: { x: COL * 4, y: ROW * 2 },
    // 0.7 → ~30% activation. Sparser than the office (0.6 / 40%) so
    // apartment rooftops read cleaner.
    inputValues: { threshold: 0.7, invert: false },
  });
  addEdge(g, { node: tankRand.id, socket: 'values' }, { node: tankMask.id, socket: 'values' });
  const tankWrap = addNode(g, 'subgraph/city-roof-water-tank', { position: { x: COL * 2, y: ROW * 2.5 } });
  const tankScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 5, y: ROW * 2 },
    inputValues: { scale: 1, align: true, seed: 0 },
  });
  addEdge(g, { node: tankPts.id,  socket: 'points' }, { node: tankScatter.id, socket: 'points' });
  addEdge(g, { node: tankMask.id, socket: 'mask' },   { node: tankScatter.id, socket: 'per_point_active' });
  addEdge(g, { node: tankWrap.id, socket: 'scene' },  { node: tankScatter.id, socket: 'instance' });
  addEdge(g, { node: tankSeed.id, socket: 'result' }, { node: tankScatter.id, socket: 'seed' });

  const merge = addNode(g, 'scene/merge', { position: { x: COL * 5, y: ROW * 0.5 } });
  addEdge(g, { node: ent.id,         socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: tankScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Apartment · roof cap',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 18 },
      { name: 'depth', type: 'Float', default: 22 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// ────────────────────────────────────────────────────────────────────
// Assembly: composes the three modules vertically.
// ────────────────────────────────────────────────────────────────────
//
// Surface contract identical to office-assembled (width, depth,
// num_floors → scene). Inputs that office-assembled has but
// apartment doesn't need (fire_escape_threshold) are absent — the
// per-lot bridge ignores unmatched inputs by name, so the same
// per-lot wiring drives both variants.

export function buildApartmentAssembledSubgraph(): SubgraphDef {
  const id = 'apartment-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 4 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 8, y: ROW * 4 } });

  // ── Derived parametric values ─────────────────────────────────────
  // bodyHeight        = num_floors * UPPER_FLOOR_HEIGHT
  // bodyTopY          = GROUND_FLOOR_HEIGHT + bodyHeight
  // lastFloorCentreY  = bodyTopY - UPPER_FLOOR_HEIGHT / 2
  // roofCapY          = bodyTopY + ROOF_CAP_HEIGHT / 2
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

  // ── Ground floor module ───────────────────────────────────────────
  const groundWrap = addNode(g, 'subgraph/apartment-ground-floor', {
    position: { x: COL * 2, y: ROW * 2 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: groundWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: groundWrap.id, socket: 'depth' });

  // ── Upper-floor module instanced N times via points/line ──────────
  // First floor centred at GROUND_FLOOR_HEIGHT + UPPER_FLOOR_HEIGHT/2.
  const firstFloorCentreY = GROUND_FLOOR_HEIGHT + UPPER_FLOOR_HEIGHT / 2;
  const startPt = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { x: 0, y: firstFloorCentreY, z: 0 },
  });
  const endPt = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 3 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: lastFloorCentreY.id, socket: 'result' }, { node: endPt.id, socket: 'y' });

  const floorPts = addNode(g, 'points/line', {
    position: { x: COL * 5, y: ROW * 3 },
    inputValues: { start: [0, firstFloorCentreY, 0], end: [0, 0, 0], count: 5 },
  });
  addEdge(g, { node: startPt.id, socket: 'value' }, { node: floorPts.id, socket: 'start' });
  addEdge(g, { node: endPt.id,   socket: 'value' }, { node: floorPts.id, socket: 'end' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: floorPts.id, socket: 'count' });

  // No setback — apartment body matches the ground-floor width
  // (distinct silhouette from the office's setback look).
  const upperWrap = addNode(g, 'subgraph/apartment-upper-floor', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: upperWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: upperWrap.id, socket: 'depth' });

  const floorScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 6, y: ROW * 3.5 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: floorPts.id,  socket: 'points' }, { node: floorScatter.id, socket: 'points' });
  addEdge(g, { node: upperWrap.id, socket: 'scene' },  { node: floorScatter.id, socket: 'instance' });

  // ── Roof cap module ───────────────────────────────────────────────
  const roofWrap = addNode(g, 'subgraph/apartment-roof-cap', {
    position: { x: COL * 2, y: ROW * 5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: roofWrap.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: roofWrap.id, socket: 'depth' });
  const roofLiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: roofCapY.id, socket: 'result' }, { node: roofLiftVec.id, socket: 'y' });
  const roofShift = addNode(g, 'scene/transform', {
    position: { x: COL * 5, y: ROW * 5 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: roofWrap.id,    socket: 'scene' }, { node: roofShift.id, socket: 'scene' });
  addEdge(g, { node: roofLiftVec.id, socket: 'value' }, { node: roofShift.id, socket: 'translate' });

  // ── Merge the three module outputs ─────────────────────────────────
  const merge = addNode(g, 'scene/merge', { position: { x: COL * 7, y: ROW * 4 } });
  addEdge(g, { node: groundWrap.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: floorScatter.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: roofShift.id,    socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Apartment (assembled)',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 18 },
      { name: 'depth',      type: 'Float', default: 22 },
      { name: 'num_floors', type: 'Float', default: 5 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
