import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Street + intersection + block-sidewalk subgraphs. Each is a flat
// arrangement of textured planes lifted slightly off y=0 so the
// painted stripes / crosswalks don't z-fight the asphalt below.
//
// World convention: the street subgraphs are authored with their
// long axis along Z (north-south). For east-west streets the
// instance wrapper rotates Y by π/2 in the main scene.
//
// All four subgraphs are parameterless — the main city scene tiles
// instances of them on a fixed grid. Variety on a single instance
// (rotation, position) is applied at the wrapper level.

const COL = 240;
const ROW = 160;

// Shared world dimensions.
const STREET_WIDTH = 18;
const BLOCK_LONG = 200;
const BLOCK_SHORT = 100;
const SIDEWALK_WIDTH = 3;

// Heights to keep painted markings just above the asphalt and
// above each other. Tiny absolute Y deltas so the markings read
// as paint on the road, not raised geometry.
const ASPHALT_Y = 0;
const STRIPE_LIFT = 0.01;
const CROSSWALK_LIFT = 0.015;

// Asphalt colour shared between all street pieces. Used both as the
// road basecolor AND as the `bg` of the dashed-centerline texture so
// the gaps between dashes blend invisibly into the surrounding road.
const ASPHALT: [number, number, number, number] = [0.18, 0.18, 0.19, 1];
const STRIPE_YELLOW: [number, number, number, number] = [1.0, 0.85, 0.2, 1];
const STRIPE_WHITE: [number, number, number, number] = [0.92, 0.92, 0.93, 1];
const SIDEWALK_GREY: [number, number, number, number] = [0.62, 0.60, 0.58, 1];

// ─── Shared helpers ───────────────────────────────────────────────

// Build a flat textured panel: plane (size + 1×1 divisions) →
// lift via transform-geometry → material → scene-entity. Returns
// the entity node so the caller can wire it into a scene-merge.
//
// `materialInputs` supplies whatever isn't textured (roughness,
// metallic, sometimes a colour basecolor literal). If `textureNode`
// is provided, its `texture` output is wired into the material's
// `basecolor` socket.
function addPanel(
  g: ReturnType<typeof createGraph>,
  opts: {
    width: number;
    depth: number;
    y: number;          // absolute world y for the panel face
    materialInputs: Record<string, unknown>;
    textureNode?: ReturnType<typeof addNode>;
    yOffset: number;    // RF graph y position for layout
    label?: string;
  },
): ReturnType<typeof addNode> {
  const { width, depth, y, materialInputs, textureNode, yOffset } = opts;
  const plane = addNode(g, 'geom/plane', {
    position: { x: COL, y: yOffset },
    inputValues: { size: [width, depth], divisions: [1, 1] },
  });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: yOffset },
    inputValues: { translate: [0, y, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  return ent;
}

// Same but translates in XZ too — needed when the panel isn't
// centred on the subgraph origin (sidewalk strips along one edge of
// a block, edge-of-lane white stripes offset from centerline, etc.).
function addOffsetPanel(
  g: ReturnType<typeof createGraph>,
  opts: {
    width: number;
    depth: number;
    translate: [number, number, number];
    materialInputs: Record<string, unknown>;
    textureNode?: ReturnType<typeof addNode>;
    yOffset: number;
  },
): ReturnType<typeof addNode> {
  const { width, depth, translate, materialInputs, textureNode, yOffset } = opts;
  const plane = addNode(g, 'geom/plane', {
    position: { x: COL, y: yOffset },
    inputValues: { size: [width, depth], divisions: [1, 1] },
  });
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: yOffset },
    inputValues: { translate, rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  return ent;
}

// Build a scene-merge with `count` Scene inputs and an output node
// hooked up. Returns { merge, output } so the caller can wire each
// entity into a specific input socket.
function addMergeAndOutput(
  g: ReturnType<typeof createGraph>,
  outputNode: ReturnType<typeof addNode>,
  count: number,
  yOffset: number,
): ReturnType<typeof addNode> {
  const extraInputs = [];
  for (let i = 0; i < count; i++) {
    extraInputs.push({ name: `scene_${i}`, type: 'Scene', optional: true });
  }
  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 5, y: yOffset },
    extraInputs,
  });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });
  return merge;
}

// ─── Internal builder for road segments ───────────────────────────
//
// Both the 200m and 100m variants share this — they differ only in
// length and the dash count (so each dash+gap pair stays roughly 10m
// in world units). One textured asphalt + centered yellow dashes +
// two solid white edge stripes. Long axis along Z.
function buildStreetSegmentImpl(
  id: string,
  length: number,
  dashCount: number,
  label: string,
): SubgraphDef {
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 4 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 4 },
  });

  // Yellow dashed centerline texture. bg matches the asphalt
  // colour so the gaps are invisible at distance. orientation=1
  // runs dashes along V (which maps to the long-axis Z of the
  // plane). stripe_width=0.9 keeps the dashes near the centre of
  // the thin centerline plane, with a bit of asphalt-coloured bg
  // gap on either side.
  const centerTex = addNode(g, 'tex/dashed-stripe', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: STRIPE_YELLOW,
      bg: ASPHALT,
      dash_count: dashCount,
      dash_fraction: 0.5,
      stripe_width: 0.9,
      orientation: 1,
      resolution: 256,
    },
  });

  // Asphalt: 18 × length.
  const asphaltEnt = addPanel(g, {
    width: STREET_WIDTH,
    depth: length,
    y: ASPHALT_Y,
    materialInputs: {
      basecolor: ASPHALT,
      roughness: 0.85,
      metallic: 0,
    },
    yOffset: ROW * 0,
  });

  // Centerline: a thin band ~0.3m wide carrying the dashed-stripe
  // texture, lifted slightly above the asphalt.
  const centerEnt = addPanel(g, {
    width: 0.3,
    depth: length,
    y: ASPHALT_Y + STRIPE_LIFT,
    materialInputs: { roughness: 0.6, metallic: 0 },
    textureNode: centerTex,
    yOffset: ROW * 1.5,
  });

  // Two solid white edge stripes, ~1m in from each side of the
  // asphalt (typical lane-edge convention). 0.15m wide.
  const leftEdgeEnt = addOffsetPanel(g, {
    width: 0.15,
    depth: length,
    translate: [-(STREET_WIDTH / 2 - 1), ASPHALT_Y + STRIPE_LIFT, 0],
    materialInputs: {
      basecolor: STRIPE_WHITE,
      roughness: 0.6,
      metallic: 0,
    },
    yOffset: ROW * 3,
  });
  const rightEdgeEnt = addOffsetPanel(g, {
    width: 0.15,
    depth: length,
    translate: [(STREET_WIDTH / 2 - 1), ASPHALT_Y + STRIPE_LIFT, 0],
    materialInputs: {
      basecolor: STRIPE_WHITE,
      roughness: 0.6,
      metallic: 0,
    },
    yOffset: ROW * 4.5,
  });

  const merge = addMergeAndOutput(g, outputNode, 4, ROW * 2);
  addEdge(g, { node: asphaltEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: centerEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: leftEdgeEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: rightEdgeEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });

  return {
    id,
    label,
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Long street segment (200m) ===================================
//
// Spans the long dimension of one block. 200m / 10m per dash+gap =
// 20 dashes.
export function buildStreetSegmentLongSubgraph(): SubgraphDef {
  return buildStreetSegmentImpl(
    'city-street-long',
    BLOCK_LONG,
    20,
    'Street Segment (long)',
  );
}

// === Short street segment (100m) ==================================
//
// Spans the short dimension of one block. 100m / 10m per pair = 10
// dashes. Same internal structure as the long variant.
export function buildStreetSegmentShortSubgraph(): SubgraphDef {
  return buildStreetSegmentImpl(
    'city-street-short',
    BLOCK_SHORT,
    10,
    'Street Segment (short)',
  );
}

// === Intersection =================================================
//
// 18×18 asphalt square + four crosswalk panels, one on each cardinal
// edge of the intersection. Each crosswalk uses the `tex/checker`
// texture to produce zebra stripes.
//
// Crosswalk orientation:
//   • N + S sides — long axis runs E-W (X), so checker has the
//     stripes perpendicular to the road. Texture divisions = [N, 1]
//     gives N stripes across the U=X axis.
//   • E + W sides — long axis runs N-S (Z), divisions = [1, N] gives
//     stripes across the V=Z axis.
export function buildIntersectionSubgraph(): SubgraphDef {
  const id = 'city-intersection';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 5 },
  });

  // ── Asphalt square.
  const asphaltEnt = addPanel(g, {
    width: STREET_WIDTH,
    depth: STREET_WIDTH,
    y: ASPHALT_Y,
    materialInputs: {
      basecolor: ASPHALT,
      roughness: 0.85,
      metallic: 0,
    },
    yOffset: 0,
  });

  // ── Crosswalk textures: one with stripes along U, one along V.
  // 8 stripes is the classic zebra count.
  const xwalkTexU = addNode(g, 'tex/checker', {
    position: { x: 0, y: ROW * 2 },
    inputValues: {
      fg: STRIPE_WHITE,
      bg: ASPHALT,
      divisions: [8, 1],
      resolution: 256,
    },
  });
  const xwalkTexV = addNode(g, 'tex/checker', {
    position: { x: 0, y: ROW * 3 },
    inputValues: {
      fg: STRIPE_WHITE,
      bg: ASPHALT,
      divisions: [1, 8],
      resolution: 256,
    },
  });

  // Crosswalk dimensions: ~3m deep (the band the pedestrian crosses)
  // × short enough that adjacent crosswalks don't overlap at the
  // intersection's corners. Each crosswalk spans the centre 12m of
  // the 18m road width, leaving a 3m gap at each end for the
  // perpendicular crosswalks to sit. Without this clearance, the
  // N and E crosswalks (both at CROSSWALK_LIFT y) z-fight in the
  // 3×3m corner where they cross.
  const xwalkInset = STREET_WIDTH / 2 - 1.8;
  const xwalkShort = 3;
  const xwalkLong = STREET_WIDTH - 2 * xwalkShort;  // 12m

  const northXwalk = addOffsetPanel(g, {
    width: xwalkLong,
    depth: xwalkShort,
    translate: [0, ASPHALT_Y + CROSSWALK_LIFT, xwalkInset],
    materialInputs: { roughness: 0.7, metallic: 0 },
    textureNode: xwalkTexU,
    yOffset: ROW * 1,
  });
  const southXwalk = addOffsetPanel(g, {
    width: xwalkLong,
    depth: xwalkShort,
    translate: [0, ASPHALT_Y + CROSSWALK_LIFT, -xwalkInset],
    materialInputs: { roughness: 0.7, metallic: 0 },
    textureNode: xwalkTexU,
    yOffset: ROW * 2,
  });
  const eastXwalk = addOffsetPanel(g, {
    width: xwalkShort,
    depth: xwalkLong,
    translate: [xwalkInset, ASPHALT_Y + CROSSWALK_LIFT, 0],
    materialInputs: { roughness: 0.7, metallic: 0 },
    textureNode: xwalkTexV,
    yOffset: ROW * 3.5,
  });
  const westXwalk = addOffsetPanel(g, {
    width: xwalkShort,
    depth: xwalkLong,
    translate: [-xwalkInset, ASPHALT_Y + CROSSWALK_LIFT, 0],
    materialInputs: { roughness: 0.7, metallic: 0 },
    textureNode: xwalkTexV,
    yOffset: ROW * 4.5,
  });

  const merge = addMergeAndOutput(g, outputNode, 5, ROW * 2);
  addEdge(g, { node: asphaltEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: northXwalk.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: southXwalk.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: eastXwalk.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: westXwalk.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });

  return {
    id,
    label: 'Intersection',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Block sidewalk ===============================================
//
// Perimeter sidewalk for a 100×200m block. Four strips of concrete-
// coloured plane laid around the edge of the block, with the
// building interior (94×194m) bare so the main scene can drop
// building wrappers inside.
//
// Convention: block centered on origin. Long axis along Z.
export function buildBlockSidewalkSubgraph(): SubgraphDef {
  const id = 'city-block-sidewalk';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 5 },
  });

  const sidewalkMat = {
    basecolor: SIDEWALK_GREY,
    roughness: 0.8,
    metallic: 0,
  };

  // North strip: full block width × sidewalk depth, sitting on the
  // +Z edge so it abuts the street to its north.
  const northEdge = addOffsetPanel(g, {
    width: BLOCK_SHORT,
    depth: SIDEWALK_WIDTH,
    translate: [0, ASPHALT_Y + STRIPE_LIFT, BLOCK_LONG / 2 - SIDEWALK_WIDTH / 2],
    materialInputs: sidewalkMat,
    yOffset: 0,
  });
  const southEdge = addOffsetPanel(g, {
    width: BLOCK_SHORT,
    depth: SIDEWALK_WIDTH,
    translate: [0, ASPHALT_Y + STRIPE_LIFT, -(BLOCK_LONG / 2 - SIDEWALK_WIDTH / 2)],
    materialInputs: sidewalkMat,
    yOffset: ROW * 1,
  });
  // East / West strips: skip the corner squares (already covered by
  // the N / S strips). 100m blocks are short-side, so EW strips are
  // (200 - 2×3) = 194m along Z.
  const eastEdge = addOffsetPanel(g, {
    width: SIDEWALK_WIDTH,
    depth: BLOCK_LONG - 2 * SIDEWALK_WIDTH,
    translate: [BLOCK_SHORT / 2 - SIDEWALK_WIDTH / 2, ASPHALT_Y + STRIPE_LIFT, 0],
    materialInputs: sidewalkMat,
    yOffset: ROW * 2,
  });
  const westEdge = addOffsetPanel(g, {
    width: SIDEWALK_WIDTH,
    depth: BLOCK_LONG - 2 * SIDEWALK_WIDTH,
    translate: [-(BLOCK_SHORT / 2 - SIDEWALK_WIDTH / 2), ASPHALT_Y + STRIPE_LIFT, 0],
    materialInputs: sidewalkMat,
    yOffset: ROW * 3,
  });

  const merge = addMergeAndOutput(g, outputNode, 4, ROW * 2);
  addEdge(g, { node: northEdge.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: southEdge.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: eastEdge.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: westEdge.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });

  return {
    id,
    label: 'Block Sidewalk',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
