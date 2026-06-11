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
      // Lazy: each wired branch is handed in as a thunk and only the
      // picked one fires. Critical for the city-style "N building
      // variants under a for-each-polygon" pattern — without lazy,
      // every variant's GPU work runs per lot per round, even though
      // only one variant survives the switch. See InputDef.lazy for
      // the contract: inputs.scenes is `Array<() => Promise<Scene>>`.
      lazy: true,
      description: 'wire two or more scenes here; `index` picks which one to forward (wrapping modulo the wired count). Branches are evaluated lazily — unselected wires never run',
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
  async evaluate(_ctx, inputs): Promise<{ scene: SceneValue }> {
    const index = Math.floor(inputs.index as number);
    // With `lazy: true`, the evaluator hands us an array of THUNKS
    // (functions that evaluate their upstream subDAG on demand)
    // rather than evaluated Scene values. Pick the index first, then
    // invoke just the chosen branch — the unselected branches never
    // fire.
    const thunks = (inputs['scenes'] as Array<() => Promise<unknown>> | undefined) ?? [];
    const n = thunks.length;
    if (n === 0) return { scene: { entities: [] } };
    const i = ((index % n) + n) % n;
    const picked = await thunks[i]!();
    // Defensive: if the picked branch evaluated to something
    // non-Scene-shaped (broken upstream, missing required input
    // somewhere in the chain), fall back to empty scene rather than
    // poisoning downstream consumers.
    if (
      picked && typeof picked === 'object'
      && Array.isArray((picked as SceneValue).entities)
    ) {
      return { scene: picked as SceneValue };
    }
    return { scene: { entities: [] } };
  },
};
