import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { SceneValue } from '../core/resources.js';

// Pick ONE of N scenes by integer index. Pairs naturally with
// `iter/for-each-polygon`'s iteration `index`: a body subgraph that
// wires the iteration index into this node's `index` input gets a
// different scene per polygon, cycling through the connected `scenes`
// list as `index % connectedCount`.
//
// Out-of-range / broken inputs are skipped during the count: with 3
// good scenes wired the index always picks one of those 3, no matter
// what value it has. JS `%` keeps the dividend's sign so the wrap
// handles negative indices too.
export const sceneSwitchNode: NodeDef = {
  id: 'scene/switch',
  category: 'Scene',
  inputs: [
    {
      name: 'index',
      type: 'Float',
      default: 0,
      // Float (not Int) so a FloatCloud broadcast input from
      // for-each-point can drive it per-iteration (no Float→Int
      // conversion exists in the type registry). The node floors the
      // value internally before the modulo, so any numeric value
      // works.
      description: 'which connected scene to pass through. Floored to an integer, then taken modulo the number of wired scenes so it wraps without bounds checks',
    },
    {
      name: 'scenes',
      type: 'Scene',
      multi: true,
      description: 'wire two or more scenes here; `index` picks which one to forward (wrapping modulo the wired count)',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the selected input scene, or an empty scene if nothing is wired into `scenes`',
    },
  ],
  doc: {
    summary: 'Pick one of N scenes by integer index (wraps modulo wired count).',
    description: `
One multi-fan-in \`scenes\` socket and one \`index\`. Inside a
[iter/for-each-polygon](../../iter/for-each-polygon) body this is the
simplest way to give each iteration a different visual: wire iteration
\`index\` into \`index\` and your alternative building / prop subgraphs
into the same \`scenes\` socket.

The index is taken modulo the wired count so it wraps; you can pass
arbitrary integers (iteration counter, hashed cloud index, etc.)
without bounds checks. Negative values wrap too.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'geom/sphere', { id: 'sphere', position: { x: 0, y: 0 }, inputValues: { radius: 0.5 } });
      const cube = addNode(g, 'geom/cube', { id: 'cube', position: { x: 0, y: 180 }, inputValues: { size: 0.8 } });
      const colA = addNode(g, 'tex/solid-color', { id: 'colA', position: { x: 0, y: 360 }, inputValues: { color: [0.85, 0.36, 0.32, 1], resolution: 32 } });
      const colB = addNode(g, 'tex/solid-color', { id: 'colB', position: { x: 0, y: 540 }, inputValues: { color: [0.32, 0.62, 0.85, 1], resolution: 32 } });
      const matA = addNode(g, 'material/pbr', { id: 'matA', position: { x: 280, y: 360 }, inputValues: { roughness: 0.6, metallic: 0 } });
      const matB = addNode(g, 'material/pbr', { id: 'matB', position: { x: 280, y: 540 }, inputValues: { roughness: 0.6, metallic: 0 } });
      const entA = addNode(g, 'scene/entity', { id: 'entA', position: { x: 560, y: 90 } });
      const entB = addNode(g, 'scene/entity', { id: 'entB', position: { x: 560, y: 360 } });
      const swt = addNode(g, 'scene/switch', {
        id: 'swt',
        position: { x: 840, y: 220 },
        inputValues: { index: 1 },
      });
      addEdge(g, { node: colA.id, socket: 'texture' }, { node: matA.id, socket: 'basecolor' });
      addEdge(g, { node: colB.id, socket: 'texture' }, { node: matB.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entA.id, socket: 'geometry' });
      addEdge(g, { node: matA.id, socket: 'material' }, { node: entA.id, socket: 'material' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entB.id, socket: 'geometry' });
      addEdge(g, { node: matB.id, socket: 'material' }, { node: entB.id, socket: 'material' });
      addEdge(g, { node: entA.id, socket: 'scene' }, { node: swt.id, socket: 'scenes' });
      addEdge(g, { node: entB.id, socket: 'scene' }, { node: swt.id, socket: 'scenes' });
      return { graph: g, rootNodeId: 'swt' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const index = Math.floor(inputs.index as number);
    const incoming = (inputs['scenes'] as SceneValue[] | undefined) ?? [];
    // Drop broken / wrong-shape entries — partial-wiring tolerance,
    // same as scene/merge.
    const connected = incoming.filter(
      (v) => v && typeof v === 'object' && Array.isArray(v.entities),
    );
    if (connected.length === 0) return { scene: { entities: [] } };
    // JS `%` keeps the dividend's sign, so an extra `+ n) % n` step
    // lands the result in [0, n) for negative indices too.
    const n = connected.length;
    const i = ((index % n) + n) % n;
    return { scene: connected[i]! };
  },
};
