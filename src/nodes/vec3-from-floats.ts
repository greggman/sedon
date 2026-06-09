import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

// Compose a Vec3 from three independent Float inputs. The point of
// this node is to let parametric subgraphs MIX a scalar (from
// `core/multiply`, `core/map-range`, an iteration broadcast, etc.)
// with constants on the other axes — e.g. translate.y = `2 +
// body_height/2` while leaving translate.x = translate.z = 0. Without
// this, the only way to feed a parametric Y was to broadcast the
// Float through Vec3 (which fills all three components with the same
// value) or to author a Vec3 literal at every call site.
//
// Pairs with the broader axis-builder set: `core/vec3-cloud-from-
// floats` for the per-point equivalent.
export const vec3FromFloatsNode: NodeDef = {
  id: 'core/vec3-from-floats',
  category: 'Math',
  inputs: [
    { name: 'x', type: 'Float', default: 0, description: 'X component' },
    { name: 'y', type: 'Float', default: 0, description: 'Y component' },
    { name: 'z', type: 'Float', default: 0, description: 'Z component' },
  ],
  outputs: [
    { name: 'value', type: 'Vec3', description: 'Vec3 = (x, y, z)' },
  ],
  doc: {
    summary: 'Compose a Vec3 from three Float scalars.',
    description: `
A glue node for parametric subgraphs. Use it when you need a Vec3
input (translate, scale, color-rgb-encoded-as-vec3, …) where ONLY
some axes are driven by other nodes and the rest are static — the
plain Float→Vec3 conversion broadcasts the same value to all three
components, which is rarely what you want.

Typical use: \`translate = (0, base_y + height/2, 0)\` where
\`base_y + height/2\` comes from a \`core/map-range\` and the other
two components stay zero.
`,
    sampleGraph: () => {
      const g = createGraph();
      const v = addNode(g, 'core/vec3-from-floats', {
        id: 'v',
        position: { x: 0, y: 0 },
        inputValues: { x: 0, y: 2.5, z: 0 },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 180 },
        inputValues: { size: 1 },
      });
      const xform = addNode(g, 'core/transform-geometry', {
        id: 'xform',
        position: { x: 280, y: 90 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: xform.id, socket: 'geometry' });
      addEdge(g, { node: v.id, socket: 'value' }, { node: xform.id, socket: 'translate' });
      return { graph: g, rootNodeId: 'xform' };
    },
  },
  evaluate(_ctx, inputs): { value: [number, number, number] } {
    const x = Number((inputs.x as number) ?? 0);
    const y = Number((inputs.y as number) ?? 0);
    const z = Number((inputs.z as number) ?? 0);
    return { value: [x, y, z] };
  },
};
