import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

// Two-input scalar sum. The missing piece in the Math node family —
// without it, composition subgraphs (e.g. a parametric building's
// "roof Y = ground_height + body_height" arithmetic) have to resort
// to map-range tricks to do basic addition. Same input/output shape
// as `core/multiply` for consistency.
export const scalarAddNode: NodeDef = {
  id: 'core/add',
  category: 'Math',
  inputs: [
    {
      name: 'a',
      type: 'Float',
      default: 0,
      description: 'first addend',
    },
    {
      name: 'b',
      type: 'Float',
      default: 0,
      description: 'second addend',
    },
  ],
  outputs: [
    {
      name: 'result',
      type: 'Float',
      description: 'a + b',
    },
  ],
  doc: {
    summary: 'Scalar sum a + b.',
    description: `
The complement to [core/multiply](../../core/multiply). Use it
anywhere a parametric subgraph needs to combine two scalar inputs
additively — most commonly inside composition graphs that compute
\`y_top = y_base + body_height\` or \`lift = bottom_offset + span\`.

For three or more terms, chain: \`add(add(a, b), c)\`.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/add', {
        id: 'add',
        position: { x: 0, y: 0 },
        inputValues: { a: 2, b: 3 },
      });
      return { graph: g, rootNodeId: 'add' };
    },
  },
  evaluate(_ctx, inputs): { result: number } {
    const a = (inputs.a as number) ?? 0;
    const b = (inputs.b as number) ?? 0;
    return { result: a + b };
  },
};
