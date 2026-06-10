import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';

// Variadic combiner: turn N individual Polygons into a PolygonList.
// Single multi-fan-in socket — wire as many Polygon outputs as you
// want into `polygons`; the evaluator hands them in as an array in
// edge-creation order. The natural way to author "here's the set of
// districts" by hand when no subdivision op has produced the list yet.

export const polygonListNode: NodeDef = {
  id: 'poly/list',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygons',
      type: 'Polygon',
      multi: true,
      description: 'wire as many Polygon outputs into this socket as you want; the node bundles them into a PolygonList in edge-creation order',
    },
  ],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'list of every connected input polygon, in edge-creation order',
    },
  ],
  doc: {
    summary: 'Variadic combiner — gather any number of Polygons into a PolygonList.',
    description: `
One multi-fan-in input socket, \`polygons\`. Wire as many Polygon
outputs into it as you like; edge-creation order is the list order.

Useful for hand-authoring district sets ("downtown polygon",
"residential polygon", "park polygon") to feed into
[iter/for-each-polygon](../../iter/for-each-polygon). For the common
"city → subdivide into blocks" case, a subdivision op
(polygon-subdivide-grid, future road-network → block extraction) will
emit a PolygonList directly without going through this combiner.
`,
    sampleGraph: () => {
      const g = createGraph();
      const a = addNode(g, 'poly/aabb', {
        id: 'a',
        position: { x: 0, y: 0 },
        inputValues: { center: [-20, 0], size: [10, 10] },
      });
      const b = addNode(g, 'poly/aabb', {
        id: 'b',
        position: { x: 0, y: 200 },
        inputValues: { center: [20, 0], size: [10, 10] },
      });
      const list = addNode(g, 'poly/list', {
        id: 'list',
        position: { x: 280, y: 100 },
      });
      addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygons' });
      addEdge(g, { node: b.id, socket: 'polygon' }, { node: list.id, socket: 'polygons' });
      return { graph: g, rootNodeId: list.id };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const incoming = (inputs['polygons'] as PolygonValue[] | undefined) ?? [];
    const polys: PolygonValue[] = [];
    for (const v of incoming) {
      // Skip slots that resolved to a falsy / wrong-shape value
      // (e.g. broken upstream). Same partial-wiring tolerance the
      // old extraInputs variant had.
      if (v && typeof v === 'object' && 'outer' in v && (v as PolygonValue).outer instanceof Float32Array) {
        polys.push(v);
      }
    }
    return { polygons: { polygons: polys } };
  },
};
