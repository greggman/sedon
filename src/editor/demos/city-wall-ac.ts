import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Wall-mounted AC unit — the "stuck-on" box you see hanging out of
// every upper-floor window in any NYC street photo. Small, blocky,
// projects ~0.4 m outward from the wall. Combined with a scatter on
// the building's +Z / -Z side walls (with a random per-point active
// mask), it gives the city's facades the irregular pock-marked
// texture that distinguishes "AAA city" from "untextured boxes."
//
// Authoring convention (scatter-aligned per `core/instance-scene-
// on-points`):
//   • Local +X — horizontal along the wall
//   • Local +Y — OUTWARD from the wall
//   • Local +Z — vertical (world-up after scatter)
//
// In `geom/box`'s width/height/depth ordering that maps to:
//   • width (X-extent)  = 0.9 m horizontal
//   • height (Y-extent) = 0.4 m outward projection
//   • depth (Z-extent)  = 0.6 m vertical
//
// The unit lifts +0.2 m along +Y so its wall-side face sits at
// local y=0 — the scatter then drops it flush against the wall.

const COL = 240;
const ROW = 160;

export function buildWallAcUnitSubgraph(): SubgraphDef {
  const id = 'city-wall-ac';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });

  // Main body — beige metallic case.
  const body = addNode(g, 'geom/box', {
    position: { x: COL, y: 0 },
    inputValues: { width: 0.9, height: 0.4, depth: 0.6 },
  });
  const bodyLift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      translate: [0, 0.2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const bodyMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: {
      basecolor: [0.78, 0.78, 0.75, 1],
      roughness: 0.55,
      metallic: 0.25,
    },
  });
  const bodyEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: 0 },
  });
  addEdge(g, { node: body.id, socket: 'geometry' },     { node: bodyLift.id, socket: 'geometry' });
  addEdge(g, { node: bodyLift.id, socket: 'geometry' }, { node: bodyEnt.id, socket: 'geometry' });
  addEdge(g, { node: bodyMat.id, socket: 'material' },  { node: bodyEnt.id, socket: 'material' });

  // Grille on the outward face — slightly darker, slightly inset so
  // the silhouette reads as a recessed front.
  const grille = addNode(g, 'geom/box', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: { width: 0.78, height: 0.05, depth: 0.48 },
  });
  const grilleLift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: ROW * 1.2 },
    inputValues: {
      // Centre on the outward face: y = 0.4 (the body's outer face) + 0.025 (half grille)
      translate: [0, 0.425, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const grilleMat = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 1.7 },
    inputValues: {
      basecolor: [0.18, 0.20, 0.22, 1],
      roughness: 0.75,
      metallic: 0.1,
    },
  });
  const grilleEnt = addNode(g, 'scene/entity', {
    position: { x: COL * 3, y: ROW * 1.2 },
  });
  addEdge(g, { node: grille.id, socket: 'geometry' },     { node: grilleLift.id, socket: 'geometry' });
  addEdge(g, { node: grilleLift.id, socket: 'geometry' }, { node: grilleEnt.id, socket: 'geometry' });
  addEdge(g, { node: grilleMat.id, socket: 'material' },  { node: grilleEnt.id, socket: 'material' });

  const merge = addNode(g, 'scene/merge', {
    position: { x: COL * 3.5, y: ROW * 0.6 },
  });
  addEdge(g, { node: bodyEnt.id,   socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: grilleEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Wall AC unit',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
