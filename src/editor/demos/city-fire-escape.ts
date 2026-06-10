import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Fire escape — built as four composed module subgraphs the way a
// Houdini / Blender user would author this kind of repeating
// architectural element:
//
//   1. `fire-escape-floor` — one repeating floor (platform + outer
//      rail + inner frame strut + stair stringer).
//   2. `fire-escape-bottom` — ground-level landing with drop ladder.
//   3. `fire-escape-top` — roof landing with roof-access ladder.
//   4. `fire-escape-assembled` — composes them.
//
// CRITICAL AXIS CONVENTION (was wrong in the original; fixed in the
// .sedon edit dated 2026-06-10): each module is authored to be
// scattered on a vertical wall via `box-face-points` on a ±Z face
// followed by `instance-scene-on-points(align: true)`. That scatter
// maps the INSTANCE's local frame to the wall's TBN basis:
//
//   • Local +X → tangent  (horizontal ALONG the wall)
//   • Local +Y → normal   (OUTWARD from the wall)
//   • Local +Z → bitangent (VERTICAL — world up)
//
// So in `geom/box`'s width/height/depth ordering:
//
//   • width  (X-extent) = horizontal along the wall
//   • HEIGHT (Y-extent) = OUTWARD projection from the wall
//   • DEPTH  (Z-extent) = VERTICAL extent on the wall
//
// The original code had height ↔ depth swapped, so a "platform"
// authored as `width=2, height=0.12, depth=1.4` came out as a box
// 0.12 m thick outward and 1.4 m tall — i.e. a thin VERTICAL slab
// instead of a horizontal one. Every box in this file follows the
// fixed convention now.

const COL = 240;
const ROW = 160;
const FRAME_WIDTH = 2.0;          // horizontal extent along the wall (X)
const PLATFORM_PROJECTION = 1.4;  // outward extent (Y)

// Shared dark steel material. Each MODULE re-declares one — the user's
// .sedon fix didn't dedupe materials inside each module (only across
// the water-tank body+cap), so we mirror that.
function addSteelMaterial(g: ReturnType<typeof createGraph>, yOff: number): ReturnType<typeof addNode> {
  return addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: yOff + ROW * 0.5 },
    inputValues: {
      basecolor: [0.20, 0.21, 0.23, 1],
      roughness: 0.7,
      metallic: 0.55,
    },
  });
}

function addSteelBox(
  g: ReturnType<typeof createGraph>,
  yOff: number,
  size: [number, number, number],
  centre: [number, number, number],
  rotate: [number, number, number] = [0, 0, 0],
): ReturnType<typeof addNode> {
  const geo = addNode(g, 'geom/box', {
    position: { x: COL, y: yOff },
    inputValues: { width: size[0], height: size[1], depth: size[2] },
  });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: yOff },
    inputValues: { translate: centre, rotate, scale: [1, 1, 1] },
  });
  const ent = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: yOff },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  const mat = addSteelMaterial(g, yOff);
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  return ent;
}

function mergeEntities(
  g: ReturnType<typeof createGraph>,
  ents: ReturnType<typeof addNode>[],
  outputNode: ReturnType<typeof addNode>,
  yOff: number,
): void {
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 3.5, y: yOff },
  });
  ents.forEach((e) => {
    addEdge(g, { node: e.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });
}

// === Module 1: one repeating floor =================================
//
// Sized for a 3.5 m floor pitch and 1.4 m outward projection. All
// boxes follow the fixed axis convention: Y is OUTWARD, Z is
// VERTICAL.
//
// `floor_height` is exposed on the SubgraphDef's surface so a future
// rewrite can drive the per-box sizes parametrically; the current
// implementation hard-codes 3.5 m and matches the .sedon fix's box
// dimensions verbatim.
export function buildFireEscapeFloorModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });
  void inputNode;

  const ents: ReturnType<typeof addNode>[] = [];

  // Platform: 2 (X) × 1.4 (Y outward) × 0.12 (Z vertical).
  // Centre lifted to Y=0.7 so the wall-side face (Y=0) sits flush
  // against the wall after scatter.
  ents.push(addSteelBox(g, ROW * 0,
    [FRAME_WIDTH, PLATFORM_PROJECTION, 0.12],
    [0, PLATFORM_PROJECTION / 2, 0],
  ));
  // Outer rail: 0.08 × 0.08 × 3.3 (= floor_height − 0.2). Stands at
  // outward Y = 1.35 (= PROJECTION − 0.05), vertically centred at
  // Z = 1.75 (half floor height).
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 3.3],
    [0, PLATFORM_PROJECTION - 0.05, 1.75],
  ));
  // Inner frame strut against the wall: 2 × 0.08 × 3.5 (full floor
  // height). At wall side Y ≈ 0.04, vertical centre Z=1.75.
  ents.push(addSteelBox(g, ROW * 1.2,
    [FRAME_WIDTH, 0.08, 3.5],
    [0, 0.04, 1.75],
  ));
  // Stair stringer: diagonal from THIS platform's outer edge UP to
  // the NEXT module's inner edge. Length √(3.5² + 1.4²) ≈ 3.77 m,
  // rotated around +X by atan2(PROJECTION, FLOOR_HEIGHT) ≈ 21.8°.
  const stringerLen = Math.sqrt(3.5 * 3.5 + PLATFORM_PROJECTION * PLATFORM_PROJECTION);
  const stringerAngle = Math.atan2(PLATFORM_PROJECTION, 3.5);
  ents.push(addSteelBox(g, ROW * 1.8,
    [0.8, 0.12, stringerLen],
    [0, PLATFORM_PROJECTION / 2, 1.75],
    [stringerAngle, 0, 0],
  ));

  mergeEntities(g, ents, outputNode, ROW * 2.5);

  return {
    id,
    label: 'Fire escape · floor module',
    category: 'Subgraphs',
    inputs: [
      { name: 'floor_height', type: 'Float', default: 3.5 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Module 2: bottom (ground-floor landing) =======================
//
// The .sedon fix dropped the `bottom_height` input entirely (it was
// declared but unwired). No parametric inputs.
//
// Three pieces, all with VERTICAL extent on Z, outward extent on Y:
//   • Platform — same footprint as a floor module.
//   • Knee rail — 0.08 × 0.08 × 1 (1 m vertical, lower than the
//     floor module's full-height rail).
//   • Drop ladder — 0.4 × 0.06 × 5 (5 m vertical, hangs DOWN from
//     outer edge, centre Z=-2.5 → spans Z=-5 to 0).
export function buildFireEscapeBottomModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-bottom';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });
  void inputNode;

  const ents: ReturnType<typeof addNode>[] = [];

  // Platform.
  ents.push(addSteelBox(g, ROW * 0,
    [FRAME_WIDTH, PLATFORM_PROJECTION, 0.12],
    [0, PLATFORM_PROJECTION / 2, 0],
  ));
  // Knee rail (short — 1 m vertical, sits at outer edge centred at
  // Z=0.5 so it spans Z=0..1).
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 1.0],
    [0, PLATFORM_PROJECTION - 0.05, 0.5],
  ));
  // Drop ladder — vertical, 5 m long, hangs DOWN from the outer
  // edge. Centred at Z=-2.5 so it spans Z=-5 to 0. After the
  // assembled fire-escape's lift (bottom placed at world Y≈5), the
  // ladder reaches Y=0 (street level).
  ents.push(addSteelBox(g, ROW * 1.2,
    [0.4, 0.06, 5.0],
    [0, PLATFORM_PROJECTION - 0.1, -2.5],
  ));

  mergeEntities(g, ents, outputNode, ROW * 2);

  return {
    id,
    label: 'Fire escape · bottom module',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Module 3: top (roof landing) ==================================
//
// Three pieces:
//   • Platform — same footprint.
//   • Tall outer rail — 0.08 × 0.08 × 1.2 (chest-height, centred
//     at Z=0.6 so it spans Z=0..1.2).
//   • Roof-access ladder — 0.4 × 0.06 × 2 (2 m vertical, centred
//     at Z=1 so it spans Z=0..2 — going UP from outer edge into
//     the roof zone).
export function buildFireEscapeTopModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-top';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });
  void inputNode;

  const ents: ReturnType<typeof addNode>[] = [];

  ents.push(addSteelBox(g, ROW * 0,
    [FRAME_WIDTH, PLATFORM_PROJECTION, 0.12],
    [0, PLATFORM_PROJECTION / 2, 0],
  ));
  // Tall outer rail.
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 1.2],
    [0, PLATFORM_PROJECTION - 0.05, 0.6],
  ));
  // Roof ladder.
  ents.push(addSteelBox(g, ROW * 1.2,
    [0.4, 0.06, 2.0],
    [0, PLATFORM_PROJECTION - 0.1, 1.0],
  ));

  mergeEntities(g, ents, outputNode, ROW * 2);

  return {
    id,
    label: 'Fire escape · top module',
    category: 'Subgraphs',
    inputs: [
      { name: 'top_height', type: 'Float', default: 2.0 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Assembly: composes bottom + N×floor + top ====================
//
// Matches the .sedon edit's topology:
//
//   • `box-face-points` on the +Y face with depth=totalSpan,
//     rows=num_floors → N evenly-spaced points along Z (vertical).
//     The cols/rows→world-axis table in box-face-points' docs
//     covers why +Y is the right axis here.
//   • Floor scatter (`align: false`) → transform-scene with
//     translate=(1, 0, halfTotal). Lift puts the bottom row at
//     Z=halfTotal − halfStep + 0.5*step = halfStep above zero.
//   • Bottom module wrapped in a `transform-scene` with
//     translate=(0, 0, 1.5) so its platform sits 1.5 m above the
//     assembly's local origin.
//   • Top module wrapped in a `transform-scene` whose Z is fed
//     from `math/add(totalSpan, 1)`. The new `math/add` node is the
//     cleanup of the old map-range workarounds for additive math.
export function buildFireEscapeAssembledSubgraph(): SubgraphDef {
  const id = 'fire-escape-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 5 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 5 } });

  // total_floor_span = num_floors * floor_height.
  const totalFloorSpan = addNode(g, 'math/multiply', {
    position: { x: COL, y: ROW * 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: totalFloorSpan.id, socket: 'a' });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: totalFloorSpan.id, socket: 'b' });

  // Per-floor placement points on the +Y face (rows distribute along
  // world Z = vertical when this assembly is scattered on a wall).
  const floorPts = addNode(g, 'points/box-face', {
    position: { x: COL * 2, y: ROW * 0 },
    inputValues: {
      axis: [0, 1, 0],
      width: FRAME_WIDTH,
      height: 0.01,
      cols: 1,
      inset: 0,
      offset: 0,
    },
  });
  addEdge(g, { node: totalFloorSpan.id, socket: 'result' }, { node: floorPts.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: floorPts.id, socket: 'rows' });

  // Floor module wrap + scatter.
  const floorWrap = addNode(g, 'subgraph/fire-escape-floor', {
    position: { x: COL * 2, y: ROW * 1 },
  });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: floorWrap.id, socket: 'floor_height' });
  const floorScatter = addNode(g, 'scene/instance-on-points', {
    position: { x: COL * 3, y: ROW * 0 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: floorPts.id, socket: 'points' }, { node: floorScatter.id, socket: 'points' });
  addEdge(g, { node: floorWrap.id, socket: 'scene' }, { node: floorScatter.id, socket: 'instance' });

  // Floor lift: translate=(1, 0, halfTotal). The x=1 default puts the
  // floor stack offset 1 m along the wall direction relative to the
  // bottom + top modules at x=0; matches the .sedon fix verbatim.
  const halfTotal = addNode(g, 'math/multiply', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: { b: 0.5 },
  });
  addEdge(g, { node: totalFloorSpan.id, socket: 'result' }, { node: halfTotal.id, socket: 'a' });
  const floorLiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 0 },
    // x=1 IS the default here (per .sedon fix). Z is wired below.
    inputValues: { x: 1, y: 0, z: 0 },
  });
  addEdge(g, { node: halfTotal.id, socket: 'result' }, { node: floorLiftVec.id, socket: 'z' });
  const floorLift = addNode(g, 'scene/transform', {
    position: { x: COL * 5, y: ROW * 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: floorScatter.id, socket: 'scene' }, { node: floorLift.id, socket: 'scene' });
  addEdge(g, { node: floorLiftVec.id, socket: 'value' }, { node: floorLift.id, socket: 'translate' });

  // Bottom module wrapped + lifted to Z=1.5.
  const bottomWrap = addNode(g, 'subgraph/fire-escape-bottom', {
    position: { x: COL * 2, y: ROW * 3 },
  });
  const bottomShift = addNode(g, 'scene/transform', {
    position: { x: COL * 5, y: ROW * 3 },
    inputValues: { translate: [0, 0, 1.5], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: bottomWrap.id, socket: 'scene' }, { node: bottomShift.id, socket: 'scene' });

  // Top module wrapped + lifted to Z = totalSpan + 1 via math/add.
  const topWrap = addNode(g, 'subgraph/fire-escape-top', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'top_height' }, { node: topWrap.id, socket: 'top_height' });
  const topZ = addNode(g, 'math/add', {
    position: { x: COL * 3, y: ROW * 4.5 },
    inputValues: { b: 1 },
  });
  addEdge(g, { node: totalFloorSpan.id, socket: 'result' }, { node: topZ.id, socket: 'a' });
  const topLiftVec = addNode(g, 'math/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: topZ.id, socket: 'result' }, { node: topLiftVec.id, socket: 'z' });
  const topShift = addNode(g, 'scene/transform', {
    position: { x: COL * 5, y: ROW * 4 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: topWrap.id, socket: 'scene' }, { node: topShift.id, socket: 'scene' });
  addEdge(g, { node: topLiftVec.id, socket: 'value' }, { node: topShift.id, socket: 'translate' });

  // Merge the three sub-scenes.
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 6, y: ROW * 2.5 },
  });
  addEdge(g, { node: bottomShift.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: floorLift.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: topShift.id,    socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Fire escape · assembled',
    category: 'Subgraphs',
    inputs: [
      { name: 'num_floors',    type: 'Float', default: 7 },
      { name: 'floor_height',  type: 'Float', default: 3.5 },
      { name: 'bottom_height', type: 'Float', default: 2.0 },
      { name: 'top_height',    type: 'Float', default: 2.0 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
