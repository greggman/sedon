import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonValue } from '../core/resources.js';

// Build a Polygon from an axis-aligned XZ rectangle. Convenience for
// "I just want the whole city footprint as one polygon" — saves the
// click-four-corners-into-polygon-from-points dance for the common
// rectangular case.
//
// `center` + `size` parameterisation (rather than min/max) so the
// editor's number-drag scrubbing feels natural — moving the rect
// around vs. resizing it are independent knobs.
//
// Output winding is counter-clockwise, matching the convention of
// `core/polygon-from-points` so the two sources are interchangeable
// downstream.

export const polygonAabbNode: NodeDef = {
  id: 'core/polygon-aabb',
  category: 'Polygon',
  inputs: [
    {
      name: 'center',
      type: 'Vec2',
      default: [0, 0],
      description: 'rectangle centre in world XZ',
    },
    {
      name: 'size',
      type: 'Vec2',
      default: [100, 100],
      description: 'rectangle full extent in world XZ (width, depth)',
    },
  ],
  outputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'rectangular polygon, 4 vertices, counter-clockwise winding',
    },
  ],
  doc: {
    summary: 'Axis-aligned rectangular polygon convenience.',
    description: `
A 4-vertex rectangular polygon on the world XZ plane. Cheapest
"polygon source" — useful as the input to a polygon-subdivision step,
as a city / district footprint, or just to render a coloured patch on
the ground via [core/polygon-to-mesh](../../core/polygon-to-mesh).

For irregular footprints use
[core/polygon-from-points](../../core/polygon-from-points) instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 60] },
      });
      const mesh = addNode(g, 'core/polygon-to-mesh', {
        id: 'mesh',
        position: { x: 280, y: 0 },
      });
      const mat = addNode(g, 'core/material', {
        id: 'mat',
        position: { x: 280, y: 160 },
        inputValues: { basecolor: [0.55, 0.7, 0.45, 1], roughness: 0.85, metallic: 0 },
      });
      const ent = addNode(g, 'core/scene-entity', {
        id: 'ent',
        position: { x: 560, y: 80 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: mesh.id, socket: 'polygon' });
      addEdge(g, { node: mesh.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
      return { graph: g, rootNodeId: 'ent' };
    },
  },
  evaluate(_ctx, inputs): { polygon: PolygonValue } {
    const center = inputs.center as [number, number];
    const size = inputs.size as [number, number];
    const cx = center[0], cz = center[1];
    const hw = size[0] / 2, hd = size[1] / 2;
    // Vertices in counter-clockwise order viewed from +Y (matching
    // polygon-from-points' output convention):
    //   (-x, -z), (+x, -z), (+x, +z), (-x, +z)
    const outer = new Float32Array([
      cx - hw, cz - hd,
      cx + hw, cz - hd,
      cx + hw, cz + hd,
      cx - hw, cz + hd,
    ]);
    return { polygon: { outer } };
  },
};
