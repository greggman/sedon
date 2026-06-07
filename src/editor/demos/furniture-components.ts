import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Reusable component subgraphs for the furniture demo. Each takes
// parameters (dimensions, material) on the boundary and emits a
// `scene: Scene`. Hero pieces (chair, table, …) merge several of
// these together — one leg subgraph used four times in `table`, one
// cushion subgraph used six times in `sofa`, etc.
//
// Naming convention: dimensions in metres (everything in the demo is
// metric so a "chair seat at h=0.45" matches real-world ergonomics).
// Components are centred on the origin in X/Z; in Y, "base at y=0"
// for stand-on-the-floor parts (legs) and "centred on y=0" for
// non-grounded parts (cushions, panels). Hero pieces translate to
// final placement.

const COL = 240;
const ROW = 160;

// === Tapered leg ======================================================
//
// Square-cross-section leg, narrower at the top than the bottom — the
// universal furniture-leg shape. Built by extruding the top face of a
// near-flat base plate with extrude.scale < 1, so the walls slope
// inward from the wide base to the narrow top. Base sits at y=0; top
// at y=height. Hero pieces translate this to the corner positions of
// a tabletop / seat / sofa base.
export function buildTaperedLegSubgraph(): SubgraphDef {
  const id = 'tapered-leg';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 2 },
  });

  // Start as a near-flat base plate of bottom_w × bottom_w. The plate
  // is 2 mm thick — small enough not to read as a separate part but
  // not so small the topology degenerates. Extruding the top face
  // upward by `height - 0.002` lifts the leg to its final height.
  const base = addNode(g, 'core/box', {
    position: { x: COL, y: ROW },
    inputValues: { width: 0.04, height: 0.002, depth: 0.04 },
  });
  // Lift so the base plate's bottom sits at y=0 instead of straddling
  // the origin. Half the plate thickness.
  const lift = addNode(g, 'core/transform', {
    position: { x: COL * 2, y: ROW },
    inputValues: { translate: [0, 0.001, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  // Select the top face (one face, normal = +Y).
  const sel = addNode(g, 'core/select-by-normal', {
    position: { x: COL * 3, y: ROW },
    inputValues: { direction: [0, 1, 0], threshold: 10, select_below: false },
  });
  // Extrude up by (height - 0.002) with taper. taper_ratio < 1 →
  // the top is smaller than the base.
  const extrude = addNode(g, 'core/extrude', {
    position: { x: COL * 4, y: ROW },
    inputValues: { offset: 0.448, scale: 0.7 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW },
  });

  // Wire boundary → params. bottom_w drives both width and depth of
  // the base plate (square cross-section). height controls extrude
  // offset; taper drives extrude scale.
  addEdge(g, { node: inputNode.id, socket: 'bottom_w' }, { node: base.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'bottom_w' }, { node: base.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'height' }, { node: extrude.id, socket: 'offset' });
  addEdge(g, { node: inputNode.id, socket: 'taper' }, { node: extrude.id, socket: 'scale' });

  addEdge(g, { node: base.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
  addEdge(g, { node: sel.id, socket: 'geometry' }, { node: extrude.id, socket: 'geometry' });
  addEdge(g, { node: extrude.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Tapered Leg',
    category: 'Subgraphs',
    inputs: [
      { name: 'bottom_w', type: 'Float', default: 0.04 },
      { name: 'height', type: 'Float', default: 0.45 },
      // taper < 1 = narrower at top. 0.7 reads as classic Scandinavian
      // furniture taper; 1.0 makes a straight prism.
      { name: 'taper', type: 'Float', default: 0.7 },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Cushion ==========================================================
//
// Heavily-bevelled box — the "rounded cushion" shape. Used by sofa
// for both seat cushions (wide / short / deep) and back cushions
// (wide / tall / thin). Same subgraph, different W/H/D parameters.
// Bevel rounds all edges; on a 0.6 × 0.15 × 0.7 cushion a 0.04m
// bevel is the puffy upholstery look.
export function buildCushionSubgraph(): SubgraphDef {
  const id = 'cushion';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW },
  });

  const body = addNode(g, 'core/box', {
    position: { x: COL, y: ROW },
    inputValues: { width: 0.6, height: 0.15, depth: 0.7 },
  });
  // Select EVERY edge: a cube has 90° edges so any reasonable
  // threshold matches them all.
  const sel = addNode(g, 'core/select-by-angle', {
    position: { x: COL * 2, y: ROW },
    inputValues: { threshold: 30 },
  });
  const bevel = addNode(g, 'core/bevel', {
    position: { x: COL * 3, y: ROW },
    inputValues: { width: 0.04, segments: 2 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW },
  });

  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: body.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'height' }, { node: body.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: body.id, socket: 'depth' });
  addEdge(g, { node: inputNode.id, socket: 'bevel' }, { node: bevel.id, socket: 'width' });

  addEdge(g, { node: body.id, socket: 'geometry' }, { node: sel.id, socket: 'geometry' });
  addEdge(g, { node: sel.id, socket: 'geometry' }, { node: bevel.id, socket: 'geometry' });
  addEdge(g, { node: bevel.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Cushion',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 0.6 },
      { name: 'height', type: 'Float', default: 0.15 },
      { name: 'depth', type: 'Float', default: 0.7 },
      // 0.04m bevel on a ~0.6m cushion reads soft / upholstered;
      // smaller (0.01) reads firm / cubic.
      { name: 'bevel', type: 'Float', default: 0.04 },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Wood panel =======================================================
//
// Flat rectangular board centred on the origin. The workhorse of
// everything-not-upholstered: chair seat, chair back, tabletop,
// bookshelf shelves / sides / back, floor planks. One subgraph
// drives them all by varying width × depth × thickness.
export function buildWoodPanelSubgraph(): SubgraphDef {
  const id = 'wood-panel';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 4, y: ROW },
  });

  const body = addNode(g, 'core/box', {
    position: { x: COL, y: ROW },
    inputValues: { width: 1.0, height: 0.04, depth: 1.0 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 2, y: ROW },
  });

  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: body.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'thickness' }, { node: body.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: body.id, socket: 'depth' });
  addEdge(g, { node: body.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Wood Panel',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 1.0 },
      { name: 'depth', type: 'Float', default: 1.0 },
      { name: 'thickness', type: 'Float', default: 0.04 },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Drawer ===========================================================
//
// One filing-cabinet drawer: a box with a paneled front face (inset +
// recessed extrude — the "raised panel" look in reverse) plus a small
// cylindrical pull centred on the face. The hero filing-cabinet
// stacks four of these vertically.
//
// Body is centred on origin; pull is hardcoded at z=depth/2 + a tiny
// offset so it stands proud of the face. Both share the same material
// input — simplest possible wiring for the demo.
export function buildDrawerSubgraph(): SubgraphDef {
  const id = 'drawer';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 7, y: ROW * 2 },
  });

  // Drawer body box.
  const body = addNode(g, 'core/box', {
    position: { x: COL, y: ROW },
    inputValues: { width: 0.4, height: 0.3, depth: 0.5 },
  });
  // Select the +Z face (drawer front).
  const selFront = addNode(g, 'core/select-by-normal', {
    position: { x: COL * 2, y: ROW },
    inputValues: { direction: [0, 0, 1], threshold: 10, select_below: false },
  });
  // Inset the front face by 2cm — gives a frame around an inner
  // recessed panel.
  const inset = addNode(g, 'core/inset', {
    position: { x: COL * 3, y: ROW },
    inputValues: { width: 0.02 },
  });
  // Push the inner panel slightly BACK into the drawer (negative
  // offset) for the "recessed panel" look. The inset's output
  // selection.faces points at the new inner face, so this extrudes
  // exactly that face.
  const recess = addNode(g, 'core/extrude', {
    position: { x: COL * 4, y: ROW },
    inputValues: { offset: -0.005, scale: 1.0 },
  });
  const bodyEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW },
  });

  // Pull: small cylinder lying horizontally, centred on the drawer
  // face. Rotated 90° around X so its axis points along +Z (sticking
  // out of the drawer).
  const pullGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { radius: 0.012, height: 0.08, segments: 16 },
  });
  // Cylinder axis runs along Y; rotate 90° around X (π/2 radians) to
  // point its axis along Z so it sticks out toward the viewer. Then
  // translate to the drawer face position (z = depth/2 + half the
  // pull length). core/transform takes RADIANS — not degrees.
  const pullTransform = addNode(g, 'core/transform', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: {
      translate: [0, 0, 0.29],
      rotate: [Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const pullEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 6, y: ROW * 2 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  // Wire boundary → body params.
  addEdge(g, { node: inputNode.id, socket: 'width' }, { node: body.id, socket: 'width' });
  addEdge(g, { node: inputNode.id, socket: 'height' }, { node: body.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'depth' }, { node: body.id, socket: 'depth' });

  // Body chain.
  addEdge(g, { node: body.id, socket: 'geometry' }, { node: selFront.id, socket: 'geometry' });
  addEdge(g, { node: selFront.id, socket: 'geometry' }, { node: inset.id, socket: 'geometry' });
  addEdge(g, { node: inset.id, socket: 'geometry' }, { node: recess.id, socket: 'geometry' });
  addEdge(g, { node: recess.id, socket: 'geometry' }, { node: bodyEntity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: bodyEntity.id, socket: 'material' });

  // Pull chain.
  addEdge(g, { node: pullGeo.id, socket: 'geometry' }, { node: pullTransform.id, socket: 'geometry' });
  addEdge(g, { node: pullTransform.id, socket: 'geometry' }, { node: pullEntity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: pullEntity.id, socket: 'material' });

  // Merge.
  addEdge(g, { node: bodyEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: pullEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Drawer',
    category: 'Subgraphs',
    inputs: [
      { name: 'width', type: 'Float', default: 0.4 },
      { name: 'height', type: 'Float', default: 0.3 },
      { name: 'depth', type: 'Float', default: 0.5 },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Book =============================================================
//
// Unit cube (1×1×1) with bottom-back-LEFT corner at the origin. Sized
// downstream via instance-scene-on-points' per_point_scale, so a row
// of books with varying widths / heights / depths comes out as one
// instanced draw of this single subgraph. Anchoring at the corner is
// what lets a downstream `points-along-axis` place each book's LEFT
// edge precisely against its predecessor's right edge (exclusive scan
// of widths) without needing a separate per-book Y / Z offset to keep
// shorter / shallower books seated on the shelf.
//
// Standalone preview is a 1m gray cube — awkward at first glance but
// the right primitive for the bookshelf. To preview a "real" book,
// drill into the Bookshelf subgraph where books appear at instanced
// scale.
export function buildBookSubgraph(): SubgraphDef {
  const id = 'book';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  // Unit cube, then translate +0.5 on each axis so the bottom-back-
  // left corner of the cube ends up at the origin (rather than the
  // centre). Always fixed; per-book size happens via per_point_scale
  // at the instance step, not via this subgraph's inputs.
  const body = addNode(g, 'core/box', {
    position: { x: COL, y: ROW },
    inputValues: { width: 1, height: 1, depth: 1 },
  });
  const corner = addNode(g, 'core/transform', {
    position: { x: COL * 2, y: ROW },
    inputValues: { translate: [0.5, 0.5, 0.5], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const tex = addNode(g, 'core/solid-color', {
    position: { x: COL, y: 0 },
    inputValues: { color: [0.6, 0.3, 0.25, 1], resolution: 4 },
  });
  const material = addNode(g, 'core/material', {
    position: { x: COL * 2, y: 0 },
    inputValues: { roughness: 0.7, metallic: 0 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW },
  });

  addEdge(g, { node: inputNode.id, socket: 'color' }, { node: tex.id, socket: 'color' });
  addEdge(g, { node: tex.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: body.id, socket: 'geometry' }, { node: corner.id, socket: 'geometry' });
  addEdge(g, { node: corner.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Book',
    category: 'Subgraphs',
    inputs: [
      { name: 'color', type: 'Color', default: [0.6, 0.3, 0.25, 1] },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
