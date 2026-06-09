import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';
import { offsetRing } from './polygon-offset.js';

// List-mode of `core/polygon-offset`: apply the same Minkowski offset
// to every polygon in a PolygonList and emit a PolygonList of the
// same length. Polygons that collapse under the offset are passed
// through as empty polygons (outer.length = 0) — downstream consumers
// can skip them by checking that length.
//
// Use case: "inset every block by 3 m for the sidewalk" — pair with
// `core/polygon-grid-subdivide` upstream and `core/for-each-polygon`
// downstream and you have a one-line block-to-buildable-area pipeline.

export const polygonListOffsetNode: NodeDef = {
  id: 'core/polygon-list-offset',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'list of polygons to offset (typically blocks from a subdivision)',
    },
    {
      name: 'offset',
      type: 'Float',
      default: -3,
      description: 'signed distance to move every edge: positive = dilate outward, negative = shrink inward. -3 m is a typical sidewalk inset',
    },
    {
      name: 'miter_limit',
      type: 'Float',
      default: 4,
      min: 1,
      description: 'maximum miter length as a multiple of |offset|',
    },
  ],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'offset polygons, same length and order as the input list. Polygons that collapse become empty (outer.length = 0)',
    },
  ],
  doc: {
    summary: 'Apply a signed Minkowski offset to every polygon in a PolygonList.',
    description: `
A list-mode wrapper around
[core/polygon-offset](../../core/polygon-offset). For every polygon in
\`polygons\`, computes the inset (negative \`offset\`) or dilate
(positive \`offset\`) and emits a list of the same length. Collapsed
polygons pass through as empty polygons so downstream indexing stays
aligned with the input.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 40] },
      });
      const grid = addNode(g, 'core/polygon-grid-subdivide', {
        id: 'grid',
        position: { x: 280, y: 0 },
        inputValues: { cols: 4, rows: 4 },
      });
      const inset = addNode(g, 'core/polygon-list-offset', {
        id: 'inset',
        position: { x: 560, y: 0 },
        inputValues: { offset: -1 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: grid.id, socket: 'polygon' });
      addEdge(g, { node: grid.id, socket: 'polygons' }, { node: inset.id, socket: 'polygons' });
      return { graph: g, rootNodeId: 'inset' };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const list = inputs.polygons as PolygonListValue | undefined;
    const offset = inputs.offset as number;
    const miterLimit = Math.max(1, inputs.miter_limit as number);
    if (!list || list.polygons.length === 0) {
      return { polygons: { polygons: [] } };
    }
    const out: PolygonValue[] = list.polygons.map((p) => {
      if (p.outer.length < 6) return { outer: new Float32Array(0) };
      const offsetOuter = offsetRing(p.outer, offset, miterLimit);
      if (!offsetOuter) return { outer: new Float32Array(0) };
      // Holes pass through unchanged (offset of holes is its own
      // upgrade once we have hole-bearing inputs).
      if (p.holes && p.holes.length > 0) {
        return { outer: offsetOuter, holes: p.holes };
      }
      return { outer: offsetOuter };
    });
    return { polygons: { polygons: out } };
  },
};
