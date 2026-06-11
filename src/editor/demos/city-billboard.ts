import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Upper-wall billboard / sign — the cheap-and-effective Spider-Man-2
// NYC lift one tier above the storefront awnings. A scatter on the
// office's street-facing wall at upper-body heights places a small
// rectangular illuminated sign at a few candidate slots, per-instance
// random-tinted from a curated saturated-colour palette.
//
// Authoring convention matches the awning (scatter-aligned frame):
//   • Local +X — along the wall (horizontal extent)
//   • Local +Y — OUTWARD from the wall (the projection direction)
//   • Local +Z — vertical (world-up after scatter)
//
// In `geom/box`'s (width, height, depth) ordering:
//   • width  = sign's horizontal extent on the wall
//   • height = how far the sign projects outward (thin: 0.15 m)
//   • depth  = vertical extent (≈ 1.2 m — readable from across the street)
//
// Material: white basecolour so per_point_tint reads cleanly; the
// SAME texture wires to `emissive` with a 4× intensity boost so signs
// glow against the dusk sky (bloom pass picks them up).

const COL = 240;
const ROW = 160;

export function buildWallSignSubgraph(): SubgraphDef {
  const id = 'city-wall-sign';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });
  void inputNode;

  // Larger box (3.5 m × 1.6 m) so the sign reads at city-overview
  // distance against the bright lit-window office facade.
  const geo = addNode(g, 'geom/box', {
    position: { x: COL, y: 0 },
    inputValues: { width: 3.5, height: 0.18, depth: 1.6 },
  });
  // Lift +Y by half the projection so the wall-side face sits at
  // local y=0 — flush against the wall after scatter alignment.
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      translate: [0, 0.09, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  // White basecolour so per_point_tint paints the sign. No emissive:
  // `scene/instance-on-points` only multiplies basecolor by the tint,
  // so an emissive component would stay white regardless of tint and
  // wash out the colour. Saturated lit basecolor is enough to read
  // against the office's emissive lit-window facade.
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: {
      basecolor: [1, 1, 1, 1],
      roughness: 0.5,
      metallic: 0.05,
    },
  });
  const ent = addNode(g, 'scene/entity', { position: { x: COL * 3, y: 0 } });
  addEdge(g, { node: geo.id,  socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id,  socket: 'geometry' });
  addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id,  socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Wall sign',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
