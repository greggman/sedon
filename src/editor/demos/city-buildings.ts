import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Modern glass-and-concrete building subgraphs for the city demo.
// Each is a vertical stack of three boxes:
//
//   ┌────────┐  ← roof cap (concrete band, 1m)
//   │        │
//   │   ▓▓   │  ← upper floors (window grid texture)
//   │   ▓▓   │
//   │        │
//   ├────────┤
//   │ ░░░░░░ │  ← ground floor (taller, distinct material)
//   └────────┘  base on y=0
//
// Why three boxes? The "ground floor differs from upper floors"
// requirement is otherwise expensive to fake — without a vertical-
// region split texture we'd be hand-authoring per-face UV transforms
// for every building. Three stacked boxes is one extra entity per
// instance and the GPU batches them anyway via the scene-entity
// kind, so the cost is negligible. The roof cap pulls extra duty
// as a parapet wall — without it the building reads as a hollow
// shoebox from above.
//
// Conventions (same as city-furniture.ts):
//   • Units are metres.
//   • Geometry centred X/Z, base at y=0 (boxes are centre-at-origin
//     so each is translated up by its own height/2).
//   • Materials baked in. Variety in the final city scene comes
//     from MIXING building types + per-instance scale randomisation,
//     not from per-wrapper-input colour tuning.
//   • One Scene output per wrapper, three entities merged inside.

const COL = 240;
const ROW = 160;

// ─── Shared helpers ───────────────────────────────────────────────

// Stack a box at (x=0, z=0) with its base at y=baseY. Adds the box,
// a transform-geometry that lifts it (centred-on-origin convention),
// a material with the given inputs, and a scene-entity wrapping the
// two. Returns the entity node so the caller can wire it into a
// scene-merge.
//
// `textureNode` is optional — when provided, its `texture` socket
// is wired into the material's `basecolor`. Otherwise the material's
// `basecolor` falls back to whatever's in `materialInputs.basecolor`
// (which can be a colour literal — material's basecolor is a
// Texture2D socket that auto-promotes colours to 1×1 textures).
function addFloorBox(
  g: ReturnType<typeof createGraph>,
  opts: {
    width: number;
    depth: number;
    height: number;
    baseY: number;
    materialInputs: Record<string, unknown>;
    textureNode?: ReturnType<typeof addNode>;
    /** Optional emissive texture (lit-window glow, neon, etc.). The
     *  texture's `texture` output wires into the material's emissive
     *  input. Use `emissiveIntensity` to push the sample into HDR for
     *  bloom. */
    emissiveTextureNode?: ReturnType<typeof addNode>;
    yOffset: number; // RF graph y position
  },
): ReturnType<typeof addNode> {
  const { width, depth, height, baseY, materialInputs, textureNode, emissiveTextureNode, yOffset } = opts;
  const geo = addNode(g, 'core/box', {
    position: { x: COL, y: yOffset },
    inputValues: { width, height, depth },
  });
  const lift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: yOffset },
    inputValues: {
      translate: [0, baseY + height / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const mat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  if (emissiveTextureNode) {
    addEdge(g, { node: emissiveTextureNode.id, socket: 'texture' }, { node: mat.id, socket: 'emissive' });
  }
  return ent;
}

// ─── Parametric variant of `addFloorBox` ──────────────────────────
// Same shape (geo + lift + material + entity) but takes node refs
// for the dimensions and base-Y so a building subgraph can be wired
// to outer width/depth/num_floors inputs. The box is sized via
// `inputValues` defaults AND edges from `widthSrc/heightSrc/depthSrc`
// — the edges override the defaults at eval, so the standalone
// preview still sees something reasonable.
function addParametricFloorBox(
  g: ReturnType<typeof createGraph>,
  opts: {
    widthSrc:  { node: string; socket: string };
    depthSrc:  { node: string; socket: string };
    heightSrc: { node: string; socket: string };
    // Vec3 source for the lift's translate. Caller composes a
    // `core/vec3-from-floats` of (0, baseY + height/2, 0).
    translateSrc: { node: string; socket: string };
    materialInputs: Record<string, unknown>;
    textureNode?: ReturnType<typeof addNode>;
    emissiveTextureNode?: ReturnType<typeof addNode>;
    yOffset: number;
  },
): ReturnType<typeof addNode> {
  const { widthSrc, depthSrc, heightSrc, translateSrc, materialInputs, textureNode, emissiveTextureNode, yOffset } = opts;
  const geo = addNode(g, 'core/box', {
    position: { x: COL, y: yOffset },
    // Defaults present so the standalone preview has a sane shape
    // before edges resolve.
    inputValues: { width: 10, height: 5, depth: 10 },
  });
  const lift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: yOffset },
    inputValues: {
      translate: [0, 2.5, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const mat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, widthSrc,  { node: geo.id, socket: 'width' });
  addEdge(g, depthSrc,  { node: geo.id, socket: 'depth' });
  addEdge(g, heightSrc, { node: geo.id, socket: 'height' });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, translateSrc, { node: lift.id, socket: 'translate' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  if (emissiveTextureNode) {
    addEdge(g, { node: emissiveTextureNode.id, socket: 'texture' }, { node: mat.id, socket: 'emissive' });
  }
  return ent;
}

// === Office: ~30m, 8 floors, horizontal-band glass + concrete =====
//
// Vertical proportions read as a mid-rise office block. The ground
// floor is 5m (storefront height); upper floors are a 7×7 window
// grid that reads as horizontal banding at city-overview distance.
// Roof cap is a 0.5m concrete band sitting above the body.
export function buildOfficeBuildingSubgraph(): SubgraphDef {
  const id = 'city-bldg-office';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 5 },
  });

  // Window-grid texture: dark glass bg + light concrete mullions.
  // 7 cols × 7 rows reads as ~7 horizontal storeys on the upper-floor
  // box's vertical extent (24.5m / 7 ≈ 3.5m per floor).
  const windowTex = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],  // concrete mullions
      bg: [0.12, 0.16, 0.22, 1],  // dark blue glass
      divisions: [7, 7],
      line_width: 0.10,
      resolution: 256,
    },
  });

  // Emissive window-light texture. SAME grid topology as windowTex
  // but with the window/mullion roles inverted: mullions are black
  // (no glow) and windows emit a warm yellow. Paired with the
  // `emissive_intensity` value below this pushes lit-window pixels
  // into HDR so the bloom pass picks them up — the city skyline
  // reads as having warm office lights at dusk.
  const officeLightTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW },
    inputValues: {
      fg: [0, 0, 0, 1],          // mullions stay dark
      bg: [1.0, 0.78, 0.45, 1],  // warm tungsten office light
      divisions: [7, 7],
      line_width: 0.10,
      resolution: 256,
    },
  });

  // Ground floor: 5m tall, slightly wider than the upper floors so
  // the upper body reads as a setback. Vertical-mullion glass.
  const groundTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],
      bg: [0.10, 0.14, 0.20, 1],
      divisions: [10, 1],
      line_width: 0.08,
      resolution: 256,
    },
  });

  const groundEnt = addFloorBox(g, {
    width: 21, depth: 26, height: 5, baseY: 0,
    materialInputs: { roughness: 0.45, metallic: 0.15 },
    textureNode: groundTex,
    yOffset: ROW * 2,
  });
  const bodyEnt = addFloorBox(g, {
    width: 20, depth: 25, height: 24.5, baseY: 5,
    // emissive_intensity = 2 nudges the glow above 1.0 in linear HDR
    // so bloom picks up the window pixels. Lower values stay subtle.
    materialInputs: { roughness: 0.4, metallic: 0.2, emissive_intensity: 2 },
    textureNode: windowTex,
    emissiveTextureNode: officeLightTex,
    yOffset: 0,
  });
  const roofEnt = addFloorBox(g, {
    width: 21, depth: 26, height: 0.6, baseY: 29.5,
    // Solid light concrete — no texture node.
    materialInputs: {
      basecolor: [0.78, 0.78, 0.80, 1],
      roughness: 0.7,
      metallic: 0.05,
    },
    yOffset: ROW * 5,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: roofEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office Building',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Parametric office: width × depth × (5 + num_floors*3.5 + 0.6) m
//
// Same three-box construction as `buildOfficeBuildingSubgraph` —
// ground floor (5 m), upper body (`num_floors` × 3.5 m), roof cap
// (0.6 m) — but every dimension is wired from outer
// `subgraph-input`s instead of baked. A city graph subdivides each
// block edge into lots and instantiates ONE wrapper per lot with
// width matched to the lot's reserved width. The eval cache batches
// identical-input invocations across lots → identical-size buildings
// share one (geometry, material) pair → one draw per unique tuple.
//
// Subgraph inputs (declared on the SubgraphDef.inputs surface):
//   width      Float   building's edge-axis extent in metres
//   depth      Float   building's perpendicular-to-edge extent
//   num_floors Float   upper-floor count (3.5 m per floor)
//
// Window grid divisions remain fixed (7×7 upper, 10×1 ground) for
// this chunk — slight texture stretching across wide buildings is
// the trade-off. Scale-invariant divisions land in a follow-up.
export function buildParametricOfficeBuildingSubgraph(): SubgraphDef {
  const id = 'city-bldg-parametric-office';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 6 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 6 },
  });

  // --- Window grid textures (same as the static office) ---
  const windowTex = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],
      bg: [0.12, 0.16, 0.22, 1],
      divisions: [7, 7],
      line_width: 0.10,
      resolution: 256,
    },
  });
  const officeLightTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW },
    inputValues: {
      fg: [0, 0, 0, 1],
      bg: [1.0, 0.78, 0.45, 1],
      divisions: [7, 7],
      line_width: 0.10,
      resolution: 256,
    },
  });
  const groundTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: [0.78, 0.78, 0.80, 1],
      bg: [0.10, 0.14, 0.20, 1],
      divisions: [10, 1],
      line_width: 0.08,
      resolution: 256,
    },
  });

  // --- Derived parametric values via map-range
  // (Sedon lacks a scalar add/multiply; map-range is the workhorse.)
  // Each map-range computes (value - in_min) * (out_max - out_min) /
  // (in_max - in_min) + out_min — with in_min=0, in_max=1 this is
  // value * (out_max - out_min) + out_min, i.e. shift + scale.
  //
  // body_height       = num_floors * 3.5
  // body_centre_y     = num_floors * 1.75 + 5         (5 + half body)
  // roof_top_baseY    = num_floors * 3.5 + 5          (top of body)
  // roof_centre_y     = num_floors * 3.5 + 5.3        (roof_top + 0.3)
  // body_width_minus1 = width * 1 - 1                 (slight setback)
  // body_depth_minus1 = depth * 1 - 1
  const bodyHeight = addNode(g, 'core/map-range', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 3.5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: bodyHeight.id, socket: 'value' });
  const bodyCentreY = addNode(g, 'core/map-range', {
    position: { x: COL, y: ROW * 3.5 },
    inputValues: { in_min: 0, in_max: 1, out_min: 5, out_max: 6.75 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: bodyCentreY.id, socket: 'value' });
  const roofCentreY = addNode(g, 'core/map-range', {
    position: { x: COL, y: ROW * 4 },
    inputValues: { in_min: 0, in_max: 1, out_min: 5.3, out_max: 8.8 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: roofCentreY.id, socket: 'value' });
  const bodyWidth = addNode(g, 'core/map-range', {
    position: { x: COL, y: ROW * 4.5 },
    inputValues: { in_min: 0, in_max: 1, out_min: -1, out_max: 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: bodyWidth.id, socket: 'value' });
  const bodyDepth = addNode(g, 'core/map-range', {
    position: { x: COL, y: ROW * 5 },
    inputValues: { in_min: 0, in_max: 1, out_min: -1, out_max: 0 },
  });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: bodyDepth.id, socket: 'value' });

  // --- Per-floor translate Vec3s — each is (0, centreY, 0).
  const groundTranslate = addNode(g, 'core/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { x: 0, y: 2.5, z: 0 },
  });
  const bodyTranslate = addNode(g, 'core/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 3.5 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: bodyCentreY.id, socket: 'result' }, { node: bodyTranslate.id, socket: 'y' });
  const roofTranslate = addNode(g, 'core/vec3-from-floats', {
    position: { x: COL * 2, y: ROW * 4 },
    inputValues: { x: 0, y: 0, z: 0 },
  });
  addEdge(g, { node: roofCentreY.id, socket: 'result' }, { node: roofTranslate.id, socket: 'y' });

  // Constant scalar wires for static dimensions. Easier than introducing
  // a `core/float` node for each constant — a `map-range` with both
  // mins == maxs collapses to "always emit out_min" regardless of input.
  // Or: just feed the box default by leaving the height edge unwired —
  // but addParametricFloorBox requires a heightSrc, so we plumb a
  // dedicated constant via a map-range. Same trick for ground/roof
  // widths (= width input directly, no setback).
  const groundHeight = addNode(g, 'core/map-range', {
    position: { x: COL * 2, y: ROW * 4.5 },
    inputValues: { in_min: 0, in_max: 1, out_min: 5, out_max: 5 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: groundHeight.id, socket: 'value' });
  const roofHeight = addNode(g, 'core/map-range', {
    position: { x: COL * 2, y: ROW * 5 },
    inputValues: { in_min: 0, in_max: 1, out_min: 0.6, out_max: 0.6 },
  });
  addEdge(g, { node: inputNode.id, socket: 'num_floors' }, { node: roofHeight.id, socket: 'value' });

  // --- Three boxes — ground, body (setback), roof
  const groundEnt = addParametricFloorBox(g, {
    widthSrc:     { node: inputNode.id,   socket: 'width' },
    depthSrc:     { node: inputNode.id,   socket: 'depth' },
    heightSrc:    { node: groundHeight.id, socket: 'result' },
    translateSrc: { node: groundTranslate.id, socket: 'value' },
    materialInputs: { roughness: 0.45, metallic: 0.15 },
    textureNode: groundTex,
    yOffset: ROW * 2,
  });
  const bodyEnt = addParametricFloorBox(g, {
    widthSrc:     { node: bodyWidth.id, socket: 'result' },
    depthSrc:     { node: bodyDepth.id, socket: 'result' },
    heightSrc:    { node: bodyHeight.id, socket: 'result' },
    translateSrc: { node: bodyTranslate.id, socket: 'value' },
    materialInputs: { roughness: 0.4, metallic: 0.2, emissive_intensity: 2 },
    textureNode: windowTex,
    emissiveTextureNode: officeLightTex,
    yOffset: 0,
  });
  const roofEnt = addParametricFloorBox(g, {
    widthSrc:     { node: inputNode.id, socket: 'width' },
    depthSrc:     { node: inputNode.id, socket: 'depth' },
    heightSrc:    { node: roofHeight.id, socket: 'result' },
    translateSrc: { node: roofTranslate.id, socket: 'value' },
    materialInputs: {
      basecolor: [0.78, 0.78, 0.80, 1],
      roughness: 0.7,
      metallic: 0.05,
    },
    yOffset: ROW * 5,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: bodyEnt.id,   socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: roofEnt.id,   socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Office Building (parametric)',
    category: 'Subgraphs',
    inputs: [
      { name: 'width',      type: 'Float', default: 21 },
      { name: 'depth',      type: 'Float', default: 26 },
      { name: 'num_floors', type: 'Float', default: 7 },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Apartment: ~20m, 6 floors, warm beige concrete ===============
//
// Lower / wider than the office. Smaller, more frequent windows on a
// warm beige concrete reads as residential. No setback — the ground
// floor is the same width as the upper floors, distinguished only by
// being taller and having a single horizontal band of windows
// instead of the upper floors' grid.
export function buildApartmentBuildingSubgraph(): SubgraphDef {
  const id = 'city-bldg-apartment';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 5 },
  });

  const windowTex = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.86, 0.78, 0.66, 1],  // beige concrete frames
      bg: [0.20, 0.22, 0.24, 1],  // slightly lighter glass
      divisions: [8, 5],
      line_width: 0.20,
      resolution: 256,
    },
  });
  const groundTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: [0.86, 0.78, 0.66, 1],
      bg: [0.30, 0.30, 0.32, 1],
      divisions: [8, 1],
      line_width: 0.15,
      resolution: 256,
    },
  });

  const groundEnt = addFloorBox(g, {
    width: 18, depth: 22, height: 3.5, baseY: 0,
    materialInputs: { roughness: 0.55, metallic: 0.05 },
    textureNode: groundTex,
    yOffset: ROW * 2,
  });
  const bodyEnt = addFloorBox(g, {
    width: 18, depth: 22, height: 16, baseY: 3.5,
    materialInputs: { roughness: 0.55, metallic: 0.05 },
    textureNode: windowTex,
    yOffset: 0,
  });
  const roofEnt = addFloorBox(g, {
    width: 18, depth: 22, height: 0.4, baseY: 19.5,
    materialInputs: {
      basecolor: [0.86, 0.78, 0.66, 1],
      roughness: 0.7,
      metallic: 0.05,
    },
    yOffset: ROW * 5,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: roofEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Apartment Building',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Shop: ~8m, 2 floors, big storefront ==========================
//
// Two floors. Ground is a big single-pane glass storefront; upper
// floor is a tighter window grid suggesting offices over retail.
// Reads as the standard "small-business mixed-use" that fills out
// a city block alongside the bigger office / apartment buildings.
export function buildShopBuildingSubgraph(): SubgraphDef {
  const id = 'city-bldg-shop';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 5 },
  });

  const storefrontTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: [0.85, 0.83, 0.78, 1],  // bright concrete frame
      bg: [0.18, 0.22, 0.26, 1],  // glass
      divisions: [3, 1],          // 3 large glass panels
      line_width: 0.06,
      resolution: 256,
    },
  });
  const upperTex = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.85, 0.83, 0.78, 1],
      bg: [0.22, 0.24, 0.26, 1],
      divisions: [6, 2],
      line_width: 0.16,
      resolution: 256,
    },
  });

  const groundEnt = addFloorBox(g, {
    width: 14, depth: 15, height: 4, baseY: 0,
    materialInputs: { roughness: 0.4, metallic: 0.15 },
    textureNode: storefrontTex,
    yOffset: ROW * 2,
  });
  const bodyEnt = addFloorBox(g, {
    width: 14, depth: 15, height: 3.6, baseY: 4,
    materialInputs: { roughness: 0.5, metallic: 0.1 },
    textureNode: upperTex,
    yOffset: 0,
  });
  // Roof cap — wider than the body to read as a cornice / awning.
  const roofEnt = addFloorBox(g, {
    width: 15, depth: 16, height: 0.4, baseY: 7.6,
    materialInputs: {
      basecolor: [0.85, 0.83, 0.78, 1],
      roughness: 0.75,
      metallic: 0.05,
    },
    yOffset: ROW * 5,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: groundEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: roofEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Shop Building',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Tower: ~55m, glass curtain wall, setback top =================
//
// Four boxes instead of three: the setback top section pulls in to
// 60% of the main footprint, giving the silhouette some skyline
// variety. Total height 55m so it dominates the 5×5 city grid as
// the "downtown" piece.
export function buildTowerBuildingSubgraph(): SubgraphDef {
  const id = 'city-bldg-tower';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 6 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 6 },
  });

  // Curtain-wall glass: many narrow vertical columns + horizontal
  // floor bands. Reads as continuous glass at distance with subtle
  // grid structure on closer approach.
  const curtainTex = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.55, 0.60, 0.65, 1],  // light metal mullions
      bg: [0.08, 0.12, 0.18, 1],  // dark blue glass
      divisions: [10, 12],
      line_width: 0.06,
      resolution: 256,
    },
  });
  const setbackTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW },
    inputValues: {
      fg: [0.55, 0.60, 0.65, 1],
      bg: [0.05, 0.09, 0.14, 1],  // darker glass on the setback
      divisions: [8, 6],
      line_width: 0.06,
      resolution: 256,
    },
  });
  const lobbyTex = addNode(g, 'core/grid', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: [0.55, 0.60, 0.65, 1],
      bg: [0.08, 0.14, 0.20, 1],
      divisions: [6, 1],          // single floor of large glass
      line_width: 0.04,
      resolution: 256,
    },
  });

  // Lobby (6m), curtain-wall body (30m), setback top (18m), roof (1m).
  const lobbyEnt = addFloorBox(g, {
    width: 26, depth: 26, height: 6, baseY: 0,
    materialInputs: { roughness: 0.35, metallic: 0.2 },
    textureNode: lobbyTex,
    yOffset: ROW * 2,
  });
  const curtainEnt = addFloorBox(g, {
    width: 25, depth: 25, height: 30, baseY: 6,
    materialInputs: { roughness: 0.3, metallic: 0.25 },
    textureNode: curtainTex,
    yOffset: 0,
  });
  const setbackEnt = addFloorBox(g, {
    width: 18, depth: 18, height: 18, baseY: 36,
    materialInputs: { roughness: 0.3, metallic: 0.25 },
    textureNode: setbackTex,
    yOffset: ROW,
  });
  const roofEnt = addFloorBox(g, {
    width: 18, depth: 18, height: 1, baseY: 54,
    materialInputs: {
      basecolor: [0.40, 0.42, 0.45, 1],
      roughness: 0.75,
      metallic: 0.1,
    },
    yOffset: ROW * 5,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 4, y: ROW * 2.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: lobbyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: curtainEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: setbackEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: roofEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_3' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tower Building',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
