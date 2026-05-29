import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

// Remaps `value` from [in_min, in_max] to [out_min, out_max] linearly. With
// `clamp` true, the output is bounded to the output range; without, values
// outside the input range extrapolate.
export const mapRangeNode: NodeDef = {
  id: 'core/map-range',
  category: 'Math',
  inputs: [
    {
      name: 'value',
      type: 'Float',
      default: 0,
      description: 'the input value being remapped',
    },
    {
      name: 'in_min',
      type: 'Float',
      default: 0,
      description: 'low end of the input range — gets mapped to out_min',
    },
    {
      name: 'in_max',
      type: 'Float',
      default: 1,
      description: 'high end of the input range — gets mapped to out_max',
    },
    {
      name: 'out_min',
      type: 'Float',
      default: 0,
      description: 'low end of the output range',
    },
    {
      name: 'out_max',
      type: 'Float',
      default: 1,
      description: 'high end of the output range',
    },
    {
      name: 'clamp',
      type: 'Bool',
      default: false,
      description: 'if true, output is bounded to [out_min, out_max]; if false, values outside [in_min, in_max] extrapolate linearly past the output range',
    },
  ],
  outputs: [
    {
      name: 'result',
      type: 'Float',
      description: '`value` linearly remapped from [in_min, in_max] to [out_min, out_max] (clamped or extrapolated per the clamp flag)',
    },
  ],
  doc: {
    summary: 'Linearly remap a Float from one range to another.',
    description:
      'The texture-and-procedural workhorse: take a Float that lives in one range and ' +
      're-express it in another. Examples — a noise value in [0, 1] needs to become a ' +
      'height in [-50, 200]; a UI slider in [0, 100] needs to drive an angle in [0, 2π]; ' +
      'a normalised distance needs to become a per-pixel scale factor.\n\n' +
      'With clamp = false (the default) values outside the input range extrapolate past ' +
      'the output range linearly — useful when the input range is just "the typical case" ' +
      'and you\'re OK with occasional outliers passing through. With clamp = true the ' +
      'output is bounded, which is what you want when a downstream consumer can\'t cope ' +
      'with out-of-range values (e.g. a colour channel that\'ll get clipped at the GPU).',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/map-range', {
        id: 'remap',
        position: { x: 0, y: 0 },
        inputValues: { value: 0.5, in_min: 0, in_max: 1, out_min: -10, out_max: 10, clamp: false },
      });
      return { graph: g, rootNodeId: 'remap' };
    },
  },
  evaluate(_ctx, inputs) {
    const v = inputs.value as number;
    const inMin = inputs.in_min as number;
    const inMax = inputs.in_max as number;
    const outMin = inputs.out_min as number;
    const outMax = inputs.out_max as number;
    const clamp = inputs.clamp as boolean;

    const range = inMax - inMin;
    // Pathological in_min === in_max: return out_min for value==in_min, otherwise
    // pin to whichever output side dominates.
    const t = range === 0 ? 0 : (v - inMin) / range;
    const tClamped = clamp ? Math.max(0, Math.min(1, t)) : t;
    return { result: outMin + tClamped * (outMax - outMin) };
  },
};
