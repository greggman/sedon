import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';

// Variadic combiner: turn N individual Polygons into a PolygonList.
// Starts with no input sockets — every input is a per-instance
// `polygon_<i>` added via the "+ Add polygon" button. Same pattern as
// `core/scene-merge`; the natural way to author "here's the set of
// districts" by hand when no subdivision op has produced the list
// yet.
//
// Unconnected inputs are silently skipped (matches scene-merge's
// partial-wiring tolerance during authoring).
//
// Once subdivision ops land (polygon-subdivide-grid in chunk 4, road-
// network face extraction later), most PolygonList values will come
// out of those ops directly rather than this combiner.

export const polygonListNode: NodeDef = {
  id: 'core/polygon-list',
  category: 'Polygon',
  inputs: [],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'list of every connected input polygon, in socket-index order. Unconnected inputs are skipped',
    },
  ],
  extraInputsSpec: {
    type: 'Polygon',
    namePrefix: 'polygon',
    addLabel: '+ Add polygon',
  },
  doc: {
    summary: 'Variadic combiner — gather any number of Polygons into a PolygonList.',
    description: `
Starts with no input sockets. Click "+ Add polygon" (or drag a Polygon
output onto the phantom drop target on the left edge) to add another
input. Each instance carries its own socket count, persisted with the
graph.

Iterates every connected input and pushes its polygon into the output
list, in socket-index order. Unconnected sockets are silently skipped.

Useful for hand-authoring district sets ("downtown polygon",
"residential polygon", "park polygon") to feed into
[core/for-each-polygon](../../core/for-each-polygon). For the common
"city → subdivide into blocks" case, a subdivision op
(polygon-subdivide-grid, future road-network → block extraction) will
emit a PolygonList directly without going through this combiner.
`,
    sampleGraph: () => {
      const g = createGraph();
      const a = addNode(g, 'core/polygon-aabb', {
        id: 'a',
        position: { x: 0, y: 0 },
        inputValues: { center: [-20, 0], size: [10, 10] },
      });
      const b = addNode(g, 'core/polygon-aabb', {
        id: 'b',
        position: { x: 0, y: 200 },
        inputValues: { center: [20, 0], size: [10, 10] },
      });
      const list = addNode(g, 'core/polygon-list', {
        id: 'list',
        position: { x: 280, y: 100 },
        extraInputs: [
          { name: 'polygon_0', type: 'Polygon', optional: true },
          { name: 'polygon_1', type: 'Polygon', optional: true },
        ],
      });
      addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_0' });
      addEdge(g, { node: b.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_1' });
      return { graph: g, rootNodeId: list.id };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const polys: PolygonValue[] = [];
    for (const v of Object.values(inputs)) {
      if (v && typeof v === 'object' && 'outer' in v && (v as PolygonValue).outer instanceof Float32Array) {
        polys.push(v as PolygonValue);
      }
    }
    return { polygons: { polygons: polys } };
  },
};
