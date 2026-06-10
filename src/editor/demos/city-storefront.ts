import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Ground-floor storefront fittings: awnings (the brightly-coloured
// rectangular fabric / metal canopies projecting from shop entrances)
// are the cheapest visible street-level lift toward the Spider-Man-2
// NYC look. A scatter on the building's outward-facing wall at
// ground-floor height places one awning every ~3-4 m, with per-
// instance random tinting from the scatter's `per_point_tint` input
// so each shop reads as a different colour from a curated palette.
//
// Authoring convention for the SCATTER-ALIGNED frame (matches
// `scene/instance-on-points`'s "local X → tangent, Y → normal,
// Z → bitangent" rule):
//   • Local +X — along the wall (horizontal extent)
//   • Local +Y — OUTWARD from the wall (the projection direction)
//   • Local +Z — vertical (world-up after scatter)
//
// So in `geom/box`'s width/height/depth ordering:
//   • width (X-extent)  = awning's horizontal width along the wall
//   • height (Y-extent) = how far the awning projects outward
//   • depth (Z-extent)  = vertical thickness of the canopy
//
// Lift along +Y so the awning's wall-side face sits at local y=0 —
// the scatter then drops it flush against the wall at every grid
// point, with per_point_tint colouring it.

const COL = 240;
const ROW = 160;

export function buildAwningSubgraph(): SubgraphDef {
  const id = 'city-storefront-awning';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });

  // Box: 2.5 m wide × 1.0 m outward × 0.35 m thick. Centred at origin.
  const geo = addNode(g, 'geom/box', {
    position: { x: COL, y: 0 },
    inputValues: { width: 2.5, height: 1.0, depth: 0.35 },
  });
  // Lift along +Y by half-projection (= 0.5) so the wall-side face
  // sits at local y=0. After scatter alignment, +Y maps to outward
  // normal, so the wall-side face lands flush against the wall.
  // Additional +Z (= up after scatter) offset of 1.6 m so the
  // awning sits at typical storefront-top height (just above doors
  // and shop windows), not at ground level.
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      translate: [0, 0.5, 1.6],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  // White basecolour so per_point_tint reads cleanly. Slight
  // roughness so the painted-fabric/metal awning catches light.
  const mat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: {
      basecolor: [1, 1, 1, 1],
      roughness: 0.6,
      metallic: 0.05,
    },
  });
  const ent = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: 0 },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' },  { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' },  { node: ent.id, socket: 'material' });
  addEdge(g, { node: ent.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Storefront awning',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
