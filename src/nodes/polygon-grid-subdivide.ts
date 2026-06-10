import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonListValue, PolygonValue } from '../core/resources.js';

// Subdivide the input polygon's bounding box into a cols×rows axis-
// aligned grid and emit one polygon per cell. The natural city-block
// generator for "Manhattan-style" cities: take a big footprint
// polygon, slice into a grid, then for-each-polygon over the result.
//
// Restriction: this v1 emits cells based purely on the polygon's
// BOUNDING BOX. For axis-aligned rectangular input polygons (the
// common case, including everything `poly/aabb` produces) the
// cells perfectly tile the polygon's interior. For arbitrary polygon
// outlines the cells outside the polygon are emitted unchanged — once
// real polygon clipping lands (Vatti / Greiner-Hormann), this node
// gets upgraded to clip every cell against the input polygon.
// Documented here so the user isn't surprised; the city demo uses an
// AABB so it doesn't hit the corner case.

export const polygonGridSubdivideNode: NodeDef = {
  id: 'poly/grid-subdivide',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'polygon to subdivide. Currently subdivides the polygon\'s BBox; for axis-aligned rectangles the cells tile the polygon\'s interior exactly',
    },
    {
      name: 'cols',
      type: 'Int',
      default: 5,
      min: 1,
      description: 'cells along X',
    },
    {
      name: 'rows',
      type: 'Int',
      default: 5,
      min: 1,
      description: 'cells along Z',
    },
  ],
  outputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description: 'cols × rows cell polygons, row-major (X-fast). Each cell is a CCW rectangle ready for downstream offset / perimeter-points',
    },
  ],
  doc: {
    summary: 'Subdivide a polygon\'s bounding box into a regular grid of rectangular cells.',
    description: `
The simplest block generator. Take a city polygon, slice into a
\`cols × rows\` grid; the resulting cells become block polygons.

Output is row-major (X-fast): cell index 0 is the (−X, −Z) corner;
index 1 steps one column along +X; index \`cols\` steps one row along
+Z; the last cell is at (+X, +Z).

Each cell is a CCW rectangle with 4 vertices, ready for
[poly/offset](../../poly/offset) (sidewalk inset) and
[points/polygon-perimeter](../../points/polygon-perimeter)
(building placement).

For a hand-irregular city outline this v1 emits cells outside the
polygon outline unchanged (it works off the bounding box). A future
upgrade clips every cell against the input polygon once Vatti-style
polygon clipping ships.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'poly/aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 40] },
      });
      const grid = addNode(g, 'poly/grid-subdivide', {
        id: 'grid',
        position: { x: 280, y: 0 },
        inputValues: { cols: 4, rows: 4 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: grid.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'grid' };
    },
  },
  evaluate(_ctx, inputs): { polygons: PolygonListValue } {
    const poly = inputs.polygon as PolygonValue;
    const cols = Math.max(1, Math.floor(inputs.cols as number));
    const rows = Math.max(1, Math.floor(inputs.rows as number));
    if (!poly || poly.outer.length < 6) {
      return { polygons: { polygons: [] } };
    }
    // BBox of the input polygon.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const ringLen = poly.outer.length / 2;
    for (let i = 0; i < ringLen; i++) {
      const x = poly.outer[i * 2]!, z = poly.outer[i * 2 + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const cellW = (maxX - minX) / cols;
    const cellH = (maxZ - minZ) / rows;
    const polygons: PolygonValue[] = [];
    for (let r = 0; r < rows; r++) {
      const z0 = minZ + r * cellH;
      const z1 = z0 + cellH;
      for (let c = 0; c < cols; c++) {
        const x0 = minX + c * cellW;
        const x1 = x0 + cellW;
        // CCW: (-x, -z), (+x, -z), (+x, +z), (-x, +z).
        polygons.push({
          outer: new Float32Array([
            x0, z0,
            x1, z0,
            x1, z1,
            x0, z1,
          ]),
        });
      }
    }
    return { polygons: { polygons } };
  },
};
