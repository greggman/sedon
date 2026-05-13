import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Leaf authoring subgraphs.
//
// Each subgraph wraps the texture-authoring pipeline for one leaf type
// and exposes the final albedo and normal maps via its boundary.
// Drilling in shows every stage of the chain so the user can tweak
// parameters and watch the downstream effects in the same preview
// pane.

const COL = 280;
const ROW = 180;

// Generic broadleaf authored as:
//
//   skeleton ─┬─→ shape ────────────────────────────────┐ (mask)
//             └─→ veins ─┬─→ distance-transform → levels ─┬─→ mix-w-veins ─┐
//                        │                                │                │
//                        └────────────────────────────────│────────────────┤
//                                                         │                ↓
//                                                         └──────────→ multiply (a, b)
//                                                                          │
//                                            ┌─────────────────────────────┤
//                                            ↓                             ↓
//                                       normal-from-height            colorize
//                                            │                             │
//                                            ↓                             ↓
//                                  (shape × normal)              (shape × colorize)
//                                            │                             │
//                                          normal                       albedo
//                                            │                             │
//                                            └────── subgraph outputs ─────┘
//
// The interesting trick is the distance-transform → levels → mix-with-
// raw-veins → multiply-with-levels chain. levels tone-adjusts the DT
// gradient (brightness + gamma); then it gets mixed back with the
// sharp veins texture so vein cores stay crisp; the multiply with
// levels brings down the overall intensity so the gradient feeds both
// the normal-map's height function and the colorize albedo at a
// usable range. Both final outputs then get multiplied by the shape
// mask so nothing extends past the leaf silhouette.
export function buildOakLeafSubgraph(): SubgraphDef {
  const id = 'oak-leaf';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: 0 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 8, y: ROW * 13 },
  });

  const skeleton = addNode(g, 'leaf/skeleton', {
    position: { x: 0, y: ROW * 7.5 },
    inputValues: {
      length: 1,
      width: 0.22,
      tipPointedness: 1.6,
      baseCurvature: 0.8,
      branchCount: 6,
      branchAngle: 55,
      branchCurve: 0.7,
      branchTaper: 0.75,
      subBranchCount: 10,
      subBranchCurveStart: 0.05,
      subBranchCurveGrowth: 0.35,
      seed: 0,
      resolution: 512,
    },
  });

  // Distance-transform on the veins, INVERTED so vein cores read as
  // bright (1) and cell interiors fall off to dark (0).
  const dt = addNode(g, 'core/distance-transform', {
    position: { x: COL * 1.2, y: ROW * 7.5 },
    inputValues: { threshold: 0.4, maxDistance: 0.06, invert: true, resolution: 512 },
  });

  // Levels: tone-adjust the DT result. Slightly lift brightness and
  // crush gamma so the vein highlights pop and the cell interiors get
  // pushed darker.
  const levels = addNode(g, 'core/levels', {
    position: { x: COL * 2.4, y: ROW * 7.5 },
    inputValues: {
      brightness: 0.015177596282958977,
      contrast: 1,
      gamma: 0.4332421875,
      resolution: 512,
    },
  });

  // mix(levels, raw veins) — fold the sharp veins back over the
  // smoothed gradient so the vein cores stay crisp. Default factor
  // of 0.5 = 50/50.
  const mixWithVeins = addNode(g, 'core/blend', {
    position: { x: COL * 3.6, y: ROW * 8.5 },
    inputValues: { mode: 0, factor: 0.5, resolution: 512 },
  });

  // multiply(levels, mixWithVeins) — bring overall intensity down so
  // the gradient feeds both the normal-map height and the colorize
  // factor at a sensible range.
  const tonedDown = addNode(g, 'core/blend', {
    position: { x: COL * 4.5, y: ROW * 10 },
    inputValues: { mode: 2, factor: 1, resolution: 512 },
  });

  // Surface normals derived from the toned-down vein field. Negative
  // strength = veins read as valleys carved into the leaf surface.
  const normal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 5.6, y: ROW * 11.3 },
    inputValues: { strength: -1.5, resolution: 512 },
  });

  // Albedo gradient: vein neighborhoods (bright in input) map to
  // `high` (pale yellow highlight); cell interiors (dark) map to
  // `low` (body green). Midpoint pinched high so most of the leaf
  // body reads as the body green and only thin neighborhoods near
  // veins get the highlight.
  const colorize = addNode(g, 'core/colorize', {
    position: { x: COL * 5.3, y: ROW * 13.3 },
    inputValues: {
      low: [0.18, 0.36, 0.16, 1],
      high: [0.82, 0.86, 0.42, 1],
      midpoint: 0.8775703125,
      resolution: 512,
    },
  });

  // Mask both final outputs by the shape so the cell colors and
  // vein normals don't bleed beyond the leaf silhouette.
  const albedoMask = addNode(g, 'core/blend', {
    position: { x: COL * 6.6, y: ROW * 12.4 },
    inputValues: { mode: 2, factor: 1, resolution: 512 },
  });
  const normalMask = addNode(g, 'core/blend', {
    position: { x: COL * 6.6, y: ROW * 14.6 },
    inputValues: { mode: 2, factor: 1, resolution: 512 },
  });

  // Wiring.
  addEdge(g, { node: skeleton.id, socket: 'veins' }, { node: dt.id, socket: 'texture' });
  addEdge(g, { node: dt.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: mixWithVeins.id, socket: 'a' });
  addEdge(g, { node: skeleton.id, socket: 'veins' }, { node: mixWithVeins.id, socket: 'b' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: tonedDown.id, socket: 'a' });
  addEdge(g, { node: mixWithVeins.id, socket: 'texture' }, { node: tonedDown.id, socket: 'b' });
  addEdge(g, { node: tonedDown.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: tonedDown.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });

  // Mask the two final maps by shape (`a` = shape, `b` = colored/normal).
  addEdge(g, { node: skeleton.id, socket: 'shape' }, { node: albedoMask.id, socket: 'a' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: albedoMask.id, socket: 'b' });
  addEdge(g, { node: skeleton.id, socket: 'shape' }, { node: normalMask.id, socket: 'a' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: normalMask.id, socket: 'b' });

  // Subgraph outputs.
  addEdge(g, { node: albedoMask.id, socket: 'texture' }, { node: outputNode.id, socket: 'albedo' });
  addEdge(g, { node: normalMask.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  return {
    id,
    label: 'Oak leaf',
    category: 'Leaves',
    inputs: [],
    outputs: [
      { name: 'albedo', type: 'Texture2D' },
      { name: 'normal', type: 'Texture2D' },
    ],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
