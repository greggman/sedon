import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

function asColor(v: unknown): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4) {
    throw new Error('expected Color (length-4 array)');
  }
  return v as [number, number, number, number];
}

function asFloat(v: unknown): number {
  if (typeof v !== 'number') {
    throw new Error('expected Float (number)');
  }
  return v;
}

export const mixNode: NodeDef = {
  id: 'core/mix',
  category: 'Math',
  inputs: [
    {
      name: 'a',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'value at factor = 0',
    },
    {
      name: 'b',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'value at factor = 1',
    },
    {
      name: 'factor',
      type: 'Float',
      default: 0.5,
      description: 'blend amount. 0 = pure a; 1 = pure b; intermediate values lerp linearly per channel (including alpha)',
    },
  ],
  outputs: [
    {
      name: 'result',
      type: 'Color',
      description: 'per-channel linear interpolation: `a + (b − a) · factor`',
    },
  ],
  doc: {
    summary: 'Linearly interpolate two Colors by a Float factor.',
    description:
      'Per-channel `a + (b − a) · factor`. Operates on Color RGBA values — for ' +
      'texture-based blending, reach for core/blend (mix mode) or core/blend-mask instead.\n\n' +
      'Use anywhere you have two colours and want to dial smoothly between them: ' +
      'subgraph boundary defaults that the parent should be able to override, hand-tuned ' +
      'gradient endpoints fed into a Palette, or one half of an A/B authoring comparison.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/mix', {
        id: 'mix',
        position: { x: 0, y: 0 },
        inputValues: {
          a: [0.18, 0.36, 0.16, 1],
          b: [0.95, 0.88, 0.42, 1],
          factor: 0.5,
        },
      });
      return { graph: g, rootNodeId: 'mix' };
    },
  },
  evaluate(_ctx, inputs) {
    const a = asColor(inputs.a);
    const b = asColor(inputs.b);
    const t = asFloat(inputs.factor);
    return {
      result: [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
      ],
    };
  },
};
