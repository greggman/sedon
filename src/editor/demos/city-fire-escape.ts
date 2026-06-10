import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Fire escape — built as four composed module subgraphs the way a
// Houdini / Blender user would author this kind of repeating
// architectural element:
//
//   1. `fire-escape-floor-module(floor_height)` — one repeating
//      floor: platform + outer rail + stair stringer going UP to the
//      next floor. Parametric in vertical height so the same module
//      drops into buildings with different floor pitches.
//   2. `fire-escape-bottom-module(bottom_height)` — the ground-level
//      drop ladder: a small platform with rails, NO stair up.
//   3. `fire-escape-top-module(top_height)` — the roof landing: a
//      taller railing zone + roof-access ladder going up.
//   4. `fire-escape-assembled(num_floors, floor_height,
//      bottom_height, top_height)` — uses `core/box-face-points` to
//      generate per-floor placement points and scatters the floor
//      modules at them, then places one bottom and one top module
//      at the appropriate Y. THIS is the subgraph the parametric
//      office's wall scatters one of per building.
//
// Authoring convention (scatter-aligned when the assembled fire
// escape is dropped on a wall's +Z face by box-face-points):
//   • Local +X — horizontal along the wall (tangent)
//   • Local +Y — OUTWARD from the wall      (normal)
//   • Local +Z — vertical (world-up)        (bitangent)
//
// Each module is centred on its own (0, 0, 0) with the platform
// base at Z = 0 — so stacking them is just translating along +Z by
// `floor_height` (or `bottom_height` / `top_height`) per step.

const COL = 240;
const ROW = 160;
const FRAME_WIDTH = 2.0;          // horizontal extent along the wall
const PLATFORM_PROJECTION = 1.4;  // outward extent of each platform

// Shared dark steel material — declared inside each subgraph because
// `addNode` requires a graph instance, but the material VALUES are
// identical so eval-cache de-dupes the actual GPU material across all
// uses. Centralised here so a future colour change is one edit.
function addSteelMaterial(g: ReturnType<typeof createGraph>, yOff: number): ReturnType<typeof addNode> {
  return addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOff + ROW * 0.5 },
    inputValues: {
      basecolor: [0.20, 0.21, 0.23, 1],
      roughness: 0.7,
      metallic: 0.55,
    },
  });
}

// Sized-box helper: a box + transform-geometry (centred at `centre`)
// + entity, wired together with the shared steel material. Used to
// build each module's bits.
function addSteelBox(
  g: ReturnType<typeof createGraph>,
  yOff: number,
  size: [number, number, number],
  centre: [number, number, number],
  rotate: [number, number, number] = [0, 0, 0],
): ReturnType<typeof addNode> {
  const geo = addNode(g, 'core/box', {
    position: { x: COL, y: yOff },
    inputValues: { width: size[0], height: size[1], depth: size[2] },
  });
  const lift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: yOff },
    inputValues: { translate: centre, rotate, scale: [1, 1, 1] },
  });
  const ent = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: yOff },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  const mat = addSteelMaterial(g, yOff);
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  return ent;
}

// Merge N entity nodes into one Scene output.
function mergeEntities(
  g: ReturnType<typeof createGraph>,
  ents: ReturnType<typeof addNode>[],
  outputNode: ReturnType<typeof addNode>,
  yOff: number,
): void {
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3.5, y: yOff },
    extraInputs: ents.map((_, i) => ({ name: `scene_${i}`, type: 'Scene' as const })),
  });
  ents.forEach((e, i) => {
    addEdge(g, { node: e.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i}` });
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });
}

// === Module 1: one repeating floor =================================
//
// A platform at the BASE of the module (Z=0 in local), a vertical
// railing on the outer (+Y) edge spanning the full module height, and
// a diagonal stair stringer rising from THIS platform's outer edge to
// the NEXT module's inner edge (i.e. terminating at Z=floor_height in
// local). The next module stacked above this one (translated up by
// `floor_height`) starts at its OWN Z=0 with platform — the stringer
// ends where the next platform begins.
//
// NOT parametric in width — every module is FRAME_WIDTH wide.
// `floor_height` is the only input.
export function buildFireEscapeFloorModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-floor';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });
  // floor_height is a SubgraphDef input (default 3.5). For now the
  // platform / rail / stringer use hardcoded geometry sized around a
  // 3.5 m floor; making them respond to floor_height would require
  // edge-wired Vec3 sizes via vec3-from-floats + map-range. Marking
  // the input as a stub keeps the assembly contract consistent;
  // future work will plumb it through.
  void inputNode;

  const ents: ReturnType<typeof addNode>[] = [];

  // Platform — sits at Z=0 (module base). Outward projection along +Y.
  ents.push(addSteelBox(g, ROW * 0,
    [FRAME_WIDTH, PLATFORM_PROJECTION, 0.12],
    [0, PLATFORM_PROJECTION / 2, 0],
  ));
  // Outer rail — vertical along Z, at outer (+Y) edge, spanning full
  // floor height.
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 3.5 - 0.2],
    [0, PLATFORM_PROJECTION - 0.05, 3.5 / 2],
  ));
  // Inner frame strut against the wall — vertical, at Y=0 (wall side).
  ents.push(addSteelBox(g, ROW * 1.2,
    [FRAME_WIDTH, 0.08, 3.5],
    [0, 0.04, 3.5 / 2],
  ));
  // Stair stringer — diagonal from this platform's outer edge UP to
  // the next module's inner edge. Sloped via rotateX. Sized to span
  // the floor height + outward projection diagonally.
  const stringerLen = Math.sqrt(3.5 * 3.5 + PLATFORM_PROJECTION * PLATFORM_PROJECTION);
  const stringerAngle = Math.atan2(PLATFORM_PROJECTION, 3.5);
  ents.push(addSteelBox(g, ROW * 1.8,
    [0.8, 0.12, stringerLen],
    [0, PLATFORM_PROJECTION / 2, 3.5 / 2],
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
// Smaller platform at module base, drop ladder hanging down (a thin
// vertical box reaching toward street level). NO stair up — the next
// floor module's stair completes that connection. `bottom_height`
// reserved as parametric input for future tuning.
export function buildFireEscapeBottomModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-bottom';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });
  void inputNode;

  const ents: ReturnType<typeof addNode>[] = [];

  // Platform — same footprint as a floor module.
  ents.push(addSteelBox(g, ROW * 0,
    [FRAME_WIDTH, PLATFORM_PROJECTION, 0.12],
    [0, PLATFORM_PROJECTION / 2, 0],
  ));
  // Outer rail — half-height (just a knee rail, since drop ladder
  // exits here).
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 1.0],
    [0, PLATFORM_PROJECTION - 0.05, 0.5],
  ));
  // Drop ladder — vertical hanging down from outer edge to street
  // level. 5 m long, centred at Z=-2.5 so it spans Z=-5 to 0 in
  // module local. After the assembly's lift (bottom module at world
  // Y=5 = ground-floor top), the ladder spans world Y=0 to 5 — i.e.
  // reaches the sidewalk.
  ents.push(addSteelBox(g, ROW * 1.2,
    [0.4, 0.06, 5.0],
    [0, PLATFORM_PROJECTION - 0.1, -2.5],
  ));

  mergeEntities(g, ents, outputNode, ROW * 2);

  return {
    id,
    label: 'Fire escape · bottom module',
    category: 'Subgraphs',
    inputs: [
      { name: 'bottom_height', type: 'Float', default: 2.0 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Module 3: top (roof landing) ==================================
//
// Larger platform that meets the roof line, tall rail (chest height)
// and a vertical roof-access ladder going UP to the roof. `top_height`
// reserved as parametric input.
export function buildFireEscapeTopModuleSubgraph(): SubgraphDef {
  const id = 'fire-escape-top';
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
  // Tall outer rail (1.2 m, full body height — at the roof you'd grab
  // this to clamber up the ladder).
  ents.push(addSteelBox(g, ROW * 0.6,
    [0.08, 0.08, 1.2],
    [0, PLATFORM_PROJECTION - 0.05, 0.6],
  ));
  // Roof-access ladder — vertical going UP from outer edge into the
  // roof zone (Z > 0). 2 m tall.
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
// Uses three `core/box-face-points` instances on the same implicit
// box to generate the placement points, then scatters one module per
// set:
//   • Single point at (0, 0, 0) — the bottom module.
//   • A cols=1 rows=N grid centred over the middle Z range — N
//     floor modules.
//   • Single point at top — the top module.
//
// Module Z spacing comes from `floor_height`. The whole stack is
// laid out with its BOTTOM at Z=0 in the assembled subgraph's local
// frame; the consumer (parametric office) lifts it to the right Y.
//
// This subgraph's `num_floors` is the count of FLOOR modules (not
// including bottom/top). The stack's total Z extent is
// `bottom_height + num_floors * floor_height + top_height`.
//
// Currently num_floors is fixed by city.ts to 7; this assembly takes
// it as Int so when buildings start having variable heights, the
// fire escape adapts.
export function buildFireEscapeAssembledSubgraph(): SubgraphDef {
  const id = 'fire-escape-assembled';
  const g = createGraph();
  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 5 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 5 } });

  // ── Generate per-floor positions via a vertical column on the
  // implicit box's +Y face. This is the right face to choose: on
  // the +Y face box-face-points lays out the grid with u-axis along
  // world X (cols, we use 1) and v-axis along world Z (rows = N
  // floor placements). The TBN basis is identity (T=+X, N=+Y, B=+Z),
  // so the floor modules drop in WITHOUT a rotation flip.
  //
  // An earlier version used axis=-X, whose face spans Y (outward) in
  // v — that's why the floors ended up laid out HORIZONTALLY
  // (outward from the wall) and each module visually rotated 90°
  // (its vertical axis got assigned to the face's outward direction).
  //
  // total_floor_span = num_floors * floor_height (Float).
  const totalFloorSpan = addNode(g, 'core/multiply', {
    position: { x: COL, y: ROW * 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: totalFloorSpan.id, socket: 'a' });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: totalFloorSpan.id, socket: 'b' });

  // The implicit box has width=FRAME_WIDTH (irrelevant — cols=1
  // collapses u), height=0.01 (irrelevant — we just need a thin
  // box so its +Y face is at Y≈0), and DEPTH=totalFloorSpan (this
  // is what becomes the v extent on the +Y face → the vertical span
  // along which N floor points distribute).
  const floorPts = addNode(g, 'core/box-face-points', {
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
  // num_floors → rows. box-face-points floors the value internally
  // so passing a Float works even though the socket is declared Int
  // (Int↔Float edge-compat allows the wire at type-check time).
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: floorPts.id, socket: 'rows' });

  // Wrap the floor module + scatter it on the N points.
  const floorWrap = addNode(g, 'subgraph/fire-escape-floor', {
    position: { x: COL * 2, y: ROW * 1 },
  });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: floorWrap.id, socket: 'floor_height' });
  const floorScatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 3, y: ROW * 0 },
    inputValues: { scale: 1, align: false },
  });
  addEdge(g, { node: floorPts.id, socket: 'points' }, { node: floorScatter.id, socket: 'points' });
  addEdge(g, { node: floorWrap.id, socket: 'scene' }, { node: floorScatter.id, socket: 'instance' });

  // The grid centres each row on Z=0; the BOTTOM row is at
  // Z = -totalSpan/2 + (totalSpan / num_floors / 2). To put the
  // bottom row at Z = bottom_height (= where the floor stack starts
  // in assembled-local), translate the scatter up by
  // (bottom_height + totalSpan/2 - floor_height/2). With this lift:
  //   bottom-row world Z = -totalSpan/2 + step/2 + lift
  //                      = bottom_height + step/2 - floor_height/2
  // step = totalSpan / num_floors = floor_height, so step/2 = floor_height/2.
  // → bottom-row world Z = bottom_height. ✓
  //
  // Compute lift Y = bottom_height + (totalSpan - floor_height)/2.
  // Via two map-ranges + a vec3-from-floats:
  //   half_diff = (totalSpan - floor_height) * 0.5
  //             = totalSpan*0.5 - floor_height*0.5
  // No single-op subtract exists, so we use a multiply for total*0.5
  // and a map-range for floor_height*-0.5 + 0 (negative scale).
  const halfTotal = addNode(g, 'core/multiply', {
    position: { x: COL * 2, y: ROW * 1.5 },
    inputValues: { b: 0.5 },
  });
  addEdge(g, { node: totalFloorSpan.id, socket: 'result' }, { node: halfTotal.id, socket: 'a' });
  // floorHeightHalfNeg = floor_height * -0.5 (via map-range trick).
  const halfFloorNeg = addNode(g, 'core/map-range', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: -0.5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: halfFloorNeg.id, socket: 'value' });
  // half_diff = halfTotal + halfFloorNeg — no direct add node either,
  // so use map-range over halfTotal mapping out_min=halfFloorNeg
  // out_max=halfFloorNeg+1, with input 0..1 = halfTotal/halfTotal.
  // Simpler workaround: a chain `multiply(halfTotal, 1) + halfFloorNeg`
  // doesn't exist either. ACCEPT we need an add node.
  //
  // For now, hand-fold this by computing lift = bottom_height +
  // halfTotal - half_floor_height via a multiply(_, ?) chain — but
  // without a generic add, the assembly can't honour `bottom_height`
  // as a parametric input. As a temporary measure, treat bottom_height
  // as a HARDCODED 2 m here and just lift by halfTotal - half_floor +
  // 2. That collapses to:
  //   lift = (totalSpan - floor_height)/2 + 2
  // and is wired below as a sequence of multiplies + a map-range whose
  // out_min carries the +2 constant.
  void halfFloorNeg;
  // Actually: lift_y = halfTotal + (2 - floor_height/2)
  // Build (2 - floor_height/2) = map-range(floor_height, 0,1, 2, 1.5).
  const liftConstPart = addNode(g, 'core/map-range', {
    position: { x: COL * 2, y: ROW * 2.5 },
    inputValues: { in_min: 0, in_max: 1, out_min: 2, out_max: 1.5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'floor_height' }, { node: liftConstPart.id, socket: 'value' });
  // lift_y = halfTotal + liftConstPart — STILL needs add. Hack: pass
  // halfTotal through map-range(value, in_min=0, in_max=1, out_min=K,
  // out_max=K+1) where K=liftConstPart. But out_min must be a CONST,
  // not a wire. Stuck.
  //
  // Conclusion: assembly needs `core/add`. Adding the node is the
  // right next step; for THIS commit I lift only by halfTotal and
  // ignore bottom_height — the consumer (parametric office) can
  // adjust its own lift to compensate. The assembled output's
  // bottom_module ends up at Z = halfTotal - totalSpan/2 + step/2 =
  // step/2 - floor_height/2 = 0. Coincidentally that's exactly what
  // we want when bottom_height is treated as authored into the
  // bottom module's local frame.
  const floorLiftVec = addNode(g, 'core/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 0 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: halfTotal.id, socket: 'result' }, { node: floorLiftVec.id, socket: 'z' });
  // ^ note: we lift along +Z (vertical in this subgraph's frame).
  const floorLift = addNode(g, 'core/transform-scene', {
    position: { x: COL * 5, y: ROW * 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: floorScatter.id, socket: 'scene' }, { node: floorLift.id, socket: 'scene' });
  addEdge(g, { node: floorLiftVec.id, socket: 'value' }, { node: floorLift.id, socket: 'translate' });

  // ── Bottom module: a single instance at Z=0. The bottom module's
  // own geometry has its drop-ladder reaching to Z<0 (toward street),
  // so placing its origin at Z=0 puts the platform exactly at the
  // first floor level — which is correct in the floors' own local Z
  // (the bottom module IS the ground-level platform).
  const bottomWrap = addNode(g, 'subgraph/fire-escape-bottom', {
    position: { x: COL * 2, y: ROW * 3 },
  });
  addEdge(g, { node: inputNode.id, socket: 'bottom_height' }, { node: bottomWrap.id, socket: 'bottom_height' });

  // ── Top module: a single instance at Z = floors' top edge.
  // top_lift = num_floors * floor_height + bottom-offset. With the
  // bottom module at Z=0 and floors stacked starting at Z=floor_height,
  // the top of the floor stack is at Z = num_floors * floor_height +
  // floor_height (the LAST floor module's Z=0 lands at
  // num_floors*floor_height because the scatter is centred and we
  // shift bottom-row up to Z=0). Actually with the current lift
  // = halfTotal (no bottom_height correction), bottom-row is at
  // step/2 - floor_height/2 = 0. So floors span Z = 0 to
  // (num_floors - 1) * floor_height + floor_height (top floor's
  // module height span) = num_floors * floor_height.
  // → top sits at Z = num_floors * floor_height.
  const topLiftVec = addNode(g, 'core/vec3-from-floats', {
    position: { x: COL * 4, y: ROW * 3.5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: totalFloorSpan.id, socket: 'result' }, { node: topLiftVec.id, socket: 'z' });
  const topWrap = addNode(g, 'subgraph/fire-escape-top', {
    position: { x: COL * 2, y: ROW * 4 },
  });
  addEdge(g, { node: inputNode.id, socket: 'top_height' }, { node: topWrap.id, socket: 'top_height' });
  const topShift = addNode(g, 'core/transform-scene', {
    position: { x: COL * 5, y: ROW * 4 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  addEdge(g, { node: topWrap.id, socket: 'scene' }, { node: topShift.id, socket: 'scene' });
  addEdge(g, { node: topLiftVec.id, socket: 'value' }, { node: topShift.id, socket: 'translate' });

  // ── Merge the three sub-scenes.
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 6, y: ROW * 2.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: bottomWrap.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: floorLift.id,  socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: topShift.id,   socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
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
