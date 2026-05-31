import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// A "cabinet cell" subgraph: one parametric rectangular box placed at
// a world-space position. Designed to be the BODY of a
// `core/for-each-point` — declares `__position` and `__index` as
// inputs so the for-each-point can auto-feed the per-iteration
// position + index, plus `size` (per-cell dimensions) and `material`
// (broadcast across iterations).
//
// The two-transform chain inside is what gets the cube to sit ON the
// grid point (not embedded in it):
//   1. lift  — pushes the unit-cube's base from y=-0.5 up to y=0
//              (the cube primitive is centred on the origin)
//   2. place — applies the per-cell size (scale) then world position
//              (translate). The scale runs BEFORE the translate so the
//              base stays at y=0 in pre-translate space, lands at
//              __position.y in world space.
//
// Used by the `cabinet` demo to test core/for-each-point end-to-end.
export function buildCabinetCellSubgraph(): SubgraphDef {
  const id = 'cabinet-cell';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  // Unit cube — gets scaled to the per-cell size in the second transform.
  const cube = addNode(g, 'core/cube', {
    position: { x: COL, y: 0 },
    inputValues: { size: 1 },
  });

  // Lift the unit cube so its base sits at y=0 (instead of straddling
  // origin). This bakes the "cabinets sit on the ground" assumption into
  // the body and means the for-each-point's `__position` can stay flat
  // on the XZ plane without per-cell Y math.
  const lift = addNode(g, 'core/transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: { translate: [0, 0.5, 0] },
  });
  // Scale to per-cell size, then translate to __position. transform's
  // scale-then-translate order is what we want: the lifted base stays
  // at y=0 in pre-translate space, then translates to __position.y.
  const place = addNode(g, 'core/transform', {
    position: { x: COL * 3, y: 0 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: 0 },
  });

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: place.id, socket: 'geometry' });
  // The for-each-point auto-feeds these implicit inputs each iteration.
  addEdge(g, { node: inputNode.id, socket: 'size' }, { node: place.id, socket: 'scale' });
  addEdge(g, { node: inputNode.id, socket: '__position' }, { node: place.id, socket: 'translate' });
  addEdge(g, { node: place.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Cabinet cell',
    category: 'Subgraphs',
    inputs: [
      // Implicit context inputs — for-each-point auto-feeds these so
      // they don't need a mirrored socket on the wrapper.
      { name: '__position', type: 'Vec3' },
      { name: '__index', type: 'Int' },
      // Mirrored on the for-each-point's surface. `size` is a Vec3 here
      // but on the for-each-point side it becomes a Vec3Cloud — wire a
      // random-vec3-cloud (per-cell variation) or a plain Vec3 (every
      // cell same size, broadcast).
      { name: 'size', type: 'Vec3' },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
