import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GrassFieldValue, SceneValue, TerrainFieldValue } from '../core/resources.js';

// Variadic Scene combiner. Single input socket marked `multi: true` —
// the store keeps every edge into it and the evaluator hands us
// `inputs.scenes` as `Array<SceneValue>`. Order = edge-creation order.
// Empty when nothing is wired in.
//
// Replaces the older "extraInputsSpec + scene_0 / scene_1 / …" pattern.
// One socket, one wire-bundle, no per-instance bookkeeping.
export const sceneMergeNode: NodeDef = {
  id: 'scene/merge',
  category: 'Scene',
  inputs: [
    {
      name: 'scenes',
      type: 'Scene',
      multi: true,
      description: 'wire as many Scene outputs into this socket as you want — the node concatenates their entity lists into one Scene and carries through grass / terrain / waterLevel sidecars',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a single scene containing the concatenation of every connected input scene\'s entities, plus carried-through grass / terrain / waterLevel sidecars',
    },
  ],
  doc: {
    summary: 'Variadic Scene combiner — concatenate any number of scenes into one.',
    description: `
One input socket, \`scenes\`, marked multi-fan-in: wire as many Scene
outputs into it as you want. Edge-creation order determines the order of
entities in the merged scene's list.

Carries through render-time sidecars that some scenes need —
\`grass\`, \`terrain\`, \`waterLevel\`. Without this propagation, routing
a [tex/grass](../../tex/grass) or
[terrain/renderer](../../terrain/renderer) scene through a merge would
silently drop the field and the renderer would only see the (often
empty) \`entities\` list. \`waterLevel\` takes the MAX across inputs so
the camera "submerges" the moment it falls below the tallest water
surface in the scene.

For "this one entity scattered at N points," use
[scene/instance-on-points](../../scene/instance-on-points) instead —
that scatters one scene; this combines many.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.5, segments: 24, rings: 12 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 180 },
        inputValues: { size: 0.8 },
      });
      // Two flat colours feed two distinct materials so the merged
      // scene reads as "two coloured objects" rather than one washed-out
      // blob. material/pbr requires a basecolor texture (not optional).
      const colA = addNode(g, 'tex/solid-color', {
        id: 'colA',
        position: { x: 0, y: 360 },
        inputValues: { color: [0.85, 0.36, 0.32, 1], resolution: 32 },
      });
      const colB = addNode(g, 'tex/solid-color', {
        id: 'colB',
        position: { x: 0, y: 540 },
        inputValues: { color: [0.32, 0.62, 0.85, 1], resolution: 32 },
      });
      const matA = addNode(g, 'material/pbr', {
        id: 'matA',
        position: { x: 280, y: 360 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const matB = addNode(g, 'material/pbr', {
        id: 'matB',
        position: { x: 280, y: 540 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entA = addNode(g, 'scene/entity', {
        id: 'entA',
        position: { x: 560, y: 90 },
        inputValues: {},
      });
      const entB = addNode(g, 'scene/entity', {
        id: 'entB',
        position: { x: 560, y: 360 },
        inputValues: {},
      });
      const merge = addNode(g, 'scene/merge', {
        id: 'merge',
        position: { x: 840, y: 220 },
        inputValues: {},
      });
      addEdge(g, { node: colA.id, socket: 'texture' }, { node: matA.id, socket: 'basecolor' });
      addEdge(g, { node: colB.id, socket: 'texture' }, { node: matB.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entA.id, socket: 'geometry' });
      addEdge(g, { node: matA.id, socket: 'material' }, { node: entA.id, socket: 'material' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entB.id, socket: 'geometry' });
      addEdge(g, { node: matB.id, socket: 'material' }, { node: entB.id, socket: 'material' });
      // Both scene/entity outputs land on the SAME multi socket.
      addEdge(g, { node: entA.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
      addEdge(g, { node: entB.id, socket: 'scene' }, { node: merge.id, socket: 'scenes' });
      return { graph: g, rootNodeId: 'merge' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const scenes = (inputs['scenes'] as SceneValue[] | undefined) ?? [];
    const entities = [];
    const grass: GrassFieldValue[] = [];
    const terrain: TerrainFieldValue[] = [];
    let waterLevel: number | undefined;
    for (const v of scenes) {
      if (v && Array.isArray(v.entities)) {
        entities.push(...v.entities);
        // Sidecar propagation: grass / terrain / waterLevel. Without
        // this a grass or terrain scene wrapped through a merge would
        // silently drop the field and the renderer would only see the
        // (often empty) `entities` list.
        if (v.grass) grass.push(...v.grass);
        if (v.terrain) terrain.push(...v.terrain);
        if (typeof v.waterLevel === 'number') {
          // MAX — camera submerges the moment it falls below the
          // tallest water surface in the scene.
          waterLevel = waterLevel === undefined ? v.waterLevel : Math.max(waterLevel, v.waterLevel);
        }
      }
    }
    const out: SceneValue = { entities };
    if (grass.length > 0) out.grass = grass;
    if (terrain.length > 0) out.terrain = terrain;
    if (waterLevel !== undefined) out.waterLevel = waterLevel;
    return { scene: out };
  },
};
