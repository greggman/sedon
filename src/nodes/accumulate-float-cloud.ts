import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue } from '../core/resources.js';

// Running sum (prefix-scan) over a FloatCloud. The general-purpose
// primitive Blender's Geometry Nodes calls "Accumulate Field" and
// Houdini's wrangle SOPs reach for via `accumulate()`. Once you have
// it, variable-width packing (books on a shelf, parquet floor strips,
// fence pickets) becomes one or two nodes of wiring instead of a
// for-each loop with manual state.
//
// Three modes:
//   • inclusive — out[i] = sum(in[0..i])
//   • exclusive — out[i] = sum(in[0..i-1])  (so out[0] = 0)
//   • centers   — out[i] = exclusive[i] + in[i] / 2
//                 = the CENTRE position of an item of width in[i]
//                 packed against items 0..i-1 — the variable-width
//                 packing convenience that the other two modes would
//                 need a follow-up arithmetic node to compute.
export const accumulateFloatCloudNode: NodeDef = {
  id: 'cloud/accumulate',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'input cloud to scan',
    },
    {
      name: 'mode',
      type: 'Int',
      default: 2,
      enumOptions: [
        { value: 0, label: 'inclusive (running total)' },
        { value: 1, label: 'exclusive (left edges)' },
        { value: 2, label: 'centers (packing centres)' },
      ],
      description:
        'scan mode. inclusive: out[i] = sum(0..i). exclusive: out[i] = sum(0..i-1) — gives left edges of packed items. centers: out[i] = exclusive + in[i]/2 — gives the CENTRE of an item of width in[i] packed against items 0..i-1 (the variable-width packing convenience)',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'running-sum cloud the same length as the input. Pair with [points/along-axis](../../points/along-axis) to turn the sums into PointCloud positions for instancing',
    },
  ],
  doc: {
    summary: 'Prefix-scan a FloatCloud — running sum (inclusive / exclusive / centres-for-packing).',
    description: `
Prefix-scan a FloatCloud. The packing primitive: given a cloud of
per-item widths, this emits the cumulative offsets needed to pack
those items against one another, either as left-edges (exclusive),
right-edges (inclusive), or centres.

The \`centres\` mode is the variable-width-packing one:
\`out[i] = sum(in[0..i-1]) + in[i] / 2\` — the centre of an item of
width \`in[i]\` packed tip-to-tail against items 0..i-1. Use case:
a row of variable-width books on a shelf, parquet floor strips of
varying widths, fence pickets with spacing jitter.

Typical books-on-a-shelf pipeline:

\`\`\`
random-float-cloud(count=14, min=0.025, max=0.05)  → widths
accumulate-float-cloud(widths, mode='centers')     → centres
points-along-axis(origin=…, axis=[1,0,0], offsets=centres) → points
instance-scene-on-points(book, points,
  per_point_tint = random-vec3-cloud(…))           → scene
\`\`\`

Equivalent to Blender's \`Accumulate Field\` + a Math node, or
Houdini's \`accumulate()\` VEX inside a Point Wrangle.
`,
    sampleGraph: () => {
      const g = createGraph();
      const r = addNode(g, 'cloud/random-float', {
        id: 'r',
        position: { x: 0, y: 0 },
        inputValues: { count: 8, min: 0.05, max: 0.15, seed: 0.4 },
      });
      const a = addNode(g, 'cloud/accumulate', {
        id: 'a',
        position: { x: 280, y: 0 },
        inputValues: { mode: 2 },
      });
      addEdge(g, { node: r.id, socket: 'values' }, { node: a.id, socket: 'values' });
      return { graph: g, rootNodeId: 'a' };
    },
  },
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const input = inputs.values as FloatCloudValue;
    const mode = Math.max(0, Math.min(2, Math.floor(inputs.mode as number)));
    const n = input.count;
    const out = new Float32Array(n);
    if (mode === 0) {
      // inclusive
      let acc = 0;
      for (let i = 0; i < n; i++) {
        acc += input.values[i]!;
        out[i] = acc;
      }
    } else if (mode === 1) {
      // exclusive — out[0] = 0, out[i] = sum 0..i-1
      let acc = 0;
      for (let i = 0; i < n; i++) {
        out[i] = acc;
        acc += input.values[i]!;
      }
    } else {
      // centers — exclusive + in[i] / 2
      let acc = 0;
      for (let i = 0; i < n; i++) {
        out[i] = acc + input.values[i]! / 2;
        acc += input.values[i]!;
      }
    }
    return { values: { values: out, count: n } };
  },
};
