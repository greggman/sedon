import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

// The natural pair to `math/vec3-from-floats`. Splits a Vec3 into its
// three Float components so downstream math nodes can operate on a
// single axis (e.g. take only the X extent of a bounding box, scale
// it, and feed it back to a transform). Without this node, the only
// way to extract a scalar from a Vec3 was to write the value to a
// per-axis literal — which doesn't work for parametric flows.
export const floatsFromVec3Node: NodeDef = {
  id: 'math/floats-from-vec3',
  category: 'Math',
  inputs: [
    { name: 'value', type: 'Vec3', default: [0, 0, 0], description: 'Vec3 to split' },
  ],
  outputs: [
    { name: 'x', type: 'Float', description: 'X component' },
    { name: 'y', type: 'Float', description: 'Y component' },
    { name: 'z', type: 'Float', description: 'Z component' },
  ],
  doc: {
    summary: 'Split a Vec3 into its three Float components.',
    description: `
The mirror of [math/vec3-from-floats](../../math/vec3-from-floats).
Use it when you need to operate on ONE axis of a Vec3 (typically a
bounding-box extent, a position component, or a colour channel) and
the surrounding math doesn't take a Vec3 directly.

Typical use: take the X extent of a [geom/aabb](../../geom/aabb)'s
\`size\` output, compute a uniform scale from it, and feed the result
back to a transform.
`,
    sampleGraph: () => {
      const g = createGraph();
      const v = addNode(g, 'math/vec3-from-floats', {
        id: 'v',
        position: { x: 0, y: 0 },
        inputValues: { x: 3, y: 7, z: 11 },
      });
      const split = addNode(g, 'math/floats-from-vec3', {
        id: 'split',
        position: { x: 280, y: 0 },
      });
      addEdge(g, { node: v.id, socket: 'value' }, { node: split.id, socket: 'value' });
      return { graph: g, rootNodeId: 'split' };
    },
  },
  evaluate(_ctx, inputs): { x: number; y: number; z: number } {
    const v = inputs.value as [number, number, number] | undefined;
    if (!v) return { x: 0, y: 0, z: 0 };
    return {
      x: Number(v[0] ?? 0),
      y: Number(v[1] ?? 0),
      z: Number(v[2] ?? 0),
    };
  },
};
