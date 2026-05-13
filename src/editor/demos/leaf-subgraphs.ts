import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Leaf authoring subgraphs.
//
// Each subgraph wraps the texture-authoring pipeline for one leaf type
// and exposes its outputs via the boundary. Drilling in shows every
// stage of the chain so the user can tweak parameters and see the
// downstream effects on the same preview pane.

const COL = 280;
const ROW = 180;

// Generic broadleaf authored as:
//
//   leaf/skeleton ─┬─→ shape ───────────────────────────────────────────┐
//                  └─→ veins ──┬─→ normal-from-height ─→ normal output  │
//                              └─→ distance-transform ─→ colorize → albedo
//
// distance-transform replaces the older blur-then-add trick: it gives
// each pixel a *linear* falloff in proximity-to-nearest-vein, which is
// exactly what produces the smooth cell-by-cell shading inside the
// leaf body. Gradient-mapping that distance gives darker color at the
// veins and lighter green/yellow in the cells between them. The shape
// mask rides through via the alpha of the colorize output (because
// colorize's `low` and `high` carry alpha = shape implicitly through
// the chain — and because veins themselves are clipped to inside the
// leaf at generation time).
export function buildOakLeafSubgraph(): SubgraphDef {
  const id = 'oak-leaf';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  const skeleton = addNode(g, 'leaf/skeleton', {
    position: { x: COL, y: ROW * 1.5 },
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

  // Normal-from-height fed by the veins density. Negative strength
  // makes veins read as valleys (carved into the surface).
  const normal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 2, y: ROW * 2.5 },
    inputValues: { strength: -1.5, resolution: 512 },
  });

  // Distance transform on the veins texture, INVERTED so that vein
  // cores read as bright (1) and cell interiors fall off toward dark
  // (0). That's the orientation colorize wants — vein neighborhoods
  // map to the `high` colorize color (the pale highlight), cells
  // map to `low` (the body green).
  const dt = addNode(g, 'core/distance-transform', {
    position: { x: COL * 2, y: ROW },
    inputValues: { threshold: 0.4, maxDistance: 0.06, invert: true, resolution: 512 },
  });

  // Multiply by the leaf shape so the "infinite distance" outside the
  // leaf doesn't bleed into the colorized output. Inside the leaf this
  // is a no-op (shape is 1); outside it clips to 0 so colorize's `low`
  // doesn't paint the background.
  const masked = addNode(g, 'core/blend', {
    position: { x: COL * 3, y: ROW },
    inputValues: { mode: 2, factor: 1, resolution: 512 },
  });

  // Gradient map: vein neighborhood (low distance → low color) is the
  // darker green; the cell interiors (high distance → high color) brighten
  // toward pale yellow-green. Midpoint pinched high so the bright color
  // only takes over deep in the cells, leaving most of the leaf in the
  // green half.
  const colorize = addNode(g, 'core/colorize', {
    position: { x: COL * 4, y: ROW },
    inputValues: {
      low: [0.18, 0.36, 0.16, 1],
      high: [0.82, 0.86, 0.42, 1],
      midpoint: 0.7,
      resolution: 512,
    },
  });

  // Wire the chain.
  addEdge(g, { node: skeleton.id, socket: 'veins' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: skeleton.id, socket: 'veins' }, { node: dt.id, socket: 'texture' });
  addEdge(g, { node: dt.id, socket: 'texture' }, { node: masked.id, socket: 'a' });
  addEdge(g, { node: skeleton.id, socket: 'shape' }, { node: masked.id, socket: 'b' });
  addEdge(g, { node: masked.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });

  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'albedo' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });
  addEdge(g, { node: skeleton.id, socket: 'shape' }, { node: outputNode.id, socket: 'shape' });

  return {
    id,
    label: 'Oak leaf',
    category: 'Leaves',
    inputs: [],
    outputs: [
      { name: 'albedo', type: 'Texture2D' },
      { name: 'normal', type: 'Texture2D' },
      { name: 'shape', type: 'Texture2D' },
    ],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
