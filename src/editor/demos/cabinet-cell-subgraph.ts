import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// A "cabinet cell" subgraph: one parametric rectangular box placed at
// a world-space position. A GENERIC body subgraph — its inputs are
// just named values it consumes, no iteration-context magic. The
// for-each-point demo's bridge wires `iteration-input.position` → the
// cell's `position` input by name; `size` and `material` flow as
// broadcast inputs through the bridge's `subgraph-input` boundary.
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
// Used by the `cabinet` demo to test iter/for-each-point end-to-end.
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
  const cube = addNode(g, 'geom/cube', {
    position: { x: COL, y: 0 },
    inputValues: { size: 1 },
  });

  // Lift the unit cube so its base sits at y=0 (instead of straddling
  // origin). This bakes the "cabinets sit on the ground" assumption into
  // the body and means the for-each-point's `__position` can stay flat
  // on the XZ plane without per-cell Y math.
  const lift = addNode(g, 'geom/transform', {
    position: { x: COL * 2, y: 0 },
    inputValues: { translate: [0, 0.5, 0] },
  });
  // Scale to per-cell size, then translate to __position. transform's
  // scale-then-translate order is what we want: the lifted base stays
  // at y=0 in pre-translate space, then translates to __position.y.
  const place = addNode(g, 'geom/transform', {
    position: { x: COL * 3, y: 0 },
  });
  const entity = addNode(g, 'scene/entity', {
    position: { x: COL * 4, y: 0 },
  });

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: place.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'size' }, { node: place.id, socket: 'scale' });
  addEdge(g, { node: inputNode.id, socket: 'position' }, { node: place.id, socket: 'translate' });
  addEdge(g, { node: place.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Cabinet cell',
    category: 'Subgraphs',
    inputs: [
      // Generic named inputs. The for-each-point's bridge auto-wires
      // its iteration-input.position to this `position` input by name
      // match. `size` and `material` flow as broadcast inputs through
      // the bridge's subgraph-input boundary — `size` becomes a
      // Vec3Cloud on the for-each-point's outer surface (so a per-
      // cell cloud wires straight in, or a plain Vec3 broadcasts).
      //
      // Defaults match what the editor's `addSubgraphSocketWithEdge`
      // captures when the user drags a wire from a node socket onto
      // the subgraph-input — it copies the target's effective value
      // so the standalone-preview eval has reasonable values to feed
      // the inner graph. Hand-built demos used to ship without these
      // and the standalone preview was degenerate (Vec3 system
      // default is [0,0,0] → place.scale = [0,0,0] → the geometry
      // collapses to a point). Keep these in sync with the wired
      // targets' node-def defaults:
      //   position → place.translate  (transform default [0,0,0])
      //   size     → place.scale      (transform default [1,1,1])
      // `material` has no static default — the subgraph-input
      // boundary supplies a lazy flat-grey PBR material for
      // standalone preview when no wrapper provides one.
      { name: 'position', type: 'Vec3', default: [0, 0, 0] },
      { name: 'size', type: 'Vec3', default: [1, 1, 1] },
      { name: 'material', type: 'Material' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
