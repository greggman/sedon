import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

export const multiplyNode: NodeDef = {
  id: 'core/multiply',
  category: 'Math',
  inputs: [
    {
      name: 'a',
      type: 'Float',
      default: 1,
      description: 'first operand',
    },
    {
      name: 'b',
      type: 'Float',
      default: 1,
      description: 'second operand',
    },
  ],
  outputs: [
    {
      name: 'result',
      type: 'Float',
      description: '`a · b`',
    },
  ],
  doc: {
    summary: 'Multiply two Floats.',
    description:
      'Just `a · b`. Use to scale a Float coming out of another node by a tunable ' +
      'constant — e.g. running a noise-driven Float (mountain height, branch length) ' +
      'through a Multiply gives you one knob to dial the overall magnitude without ' +
      'touching the upstream graph.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/multiply', {
        id: 'mul',
        position: { x: 0, y: 0 },
        inputValues: { a: 2, b: 3 },
      });
      return { graph: g, rootNodeId: 'mul' };
    },
  },
  evaluate(_ctx, inputs) {
    return { result: (inputs.a as number) * (inputs.b as number) };
  },
};
