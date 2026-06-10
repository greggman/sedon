import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type { SceneValue } from '../core/resources.js';

// Pick ONE of N scenes by integer index. Pairs naturally with
// `iter/for-each-polygon`'s iteration `index`: a body subgraph that
// wires the iteration index into this node's `index` input gets a
// different scene per polygon, cycling through the connected
// scene_0…scene_N as `index % connectedCount`.
//
// Out-of-range / unconnected sockets are skipped during the count, so
// `index = 7` with only 3 connected slots picks index 7 % 3 = 1.
// Unconnected sockets at lower indices don't shift the mapping —
// scene_0…scene_3 with scene_1 unconnected behaves as a 3-element
// list [scene_0, scene_2, scene_3].
//
// Sidecar fields (grass/terrain/waterLevel) on the selected scene
// pass through unchanged — same shape as `scene/merge` for the
// single picked input.
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
      description: 'which connected scene to pass through. Floored to an integer, then taken modulo the number of connected `scene_*` sockets so it wraps without bounds checks',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'the selected input scene, or an empty scene if no `scene_*` sockets are connected',
    },
  ],
  extraInputsSpec: {
    type: 'Scene',
    namePrefix: 'scene',
    addLabel: '+ Add scene',
  },
  doc: {
    summary: 'Pick one of N scenes by integer index (wraps modulo connected count).',
    description: `
Starts with NO scene sockets — click "+ Add scene" to add more.
Inside a [iter/for-each-polygon](../../iter/for-each-polygon) body
this is the simplest way to give each iteration a different visual:
wire iteration \`index\` into \`index\` and a different building /
prop subgraph into each \`scene_*\`.

The index is taken modulo the connected count so it wraps; you can
pass arbitrary integers (iteration counter, hashed cloud index, etc.)
without bounds checks.
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
      const extras: InputDef[] = [
        { name: 'scene_0', type: 'Scene' },
        { name: 'scene_1', type: 'Scene' },
      ];
      const swt = addNode(g, 'scene/switch', {
        id: 'swt',
        position: { x: 840, y: 220 },
        inputValues: { index: 1 },
        extraInputs: extras,
      });
      addEdge(g, { node: colA.id, socket: 'texture' }, { node: matA.id, socket: 'basecolor' });
      addEdge(g, { node: colB.id, socket: 'texture' }, { node: matB.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entA.id, socket: 'geometry' });
      addEdge(g, { node: matA.id, socket: 'material' }, { node: entA.id, socket: 'material' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entB.id, socket: 'geometry' });
      addEdge(g, { node: matB.id, socket: 'material' }, { node: entB.id, socket: 'material' });
      addEdge(g, { node: entA.id, socket: 'scene' }, { node: swt.id, socket: 'scene_0' });
      addEdge(g, { node: entB.id, socket: 'scene' }, { node: swt.id, socket: 'scene_1' });
      return { graph: g, rootNodeId: 'swt' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const index = Math.floor(inputs.index as number);
    // Collect connected scenes preserving their socket order. We rely
    // on insertion order of Object.keys() reflecting `scene_0`,
    // `scene_1`, … as authored.
    const connected: SceneValue[] = [];
    const keys = Object.keys(inputs)
      .filter((k) => k.startsWith('scene_'))
      .sort((a, b) => {
        const ai = parseInt(a.slice('scene_'.length), 10);
        const bi = parseInt(b.slice('scene_'.length), 10);
        return ai - bi;
      });
    for (const k of keys) {
      const v = inputs[k];
      if (v && typeof v === 'object' && Array.isArray((v as SceneValue).entities)) {
        connected.push(v as SceneValue);
      }
    }
    if (connected.length === 0) return { scene: { entities: [] } };
    // JS `%` keeps sign of dividend, so negative indices need an extra
    // pass through `+ N` to land in [0, N).
    const n = connected.length;
    const i = ((index % n) + n) % n;
    return { scene: connected[i]! };
  },
};
