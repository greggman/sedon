import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type { GrassFieldValue, SceneValue, TerrainFieldValue } from '../core/resources.js';

// Variadic Scene merge. Starts with NO input sockets — every input is a
// per-instance extra added via the node's "+ Add scene" button (or by
// dragging a Scene output onto the phantom "+ Add" drop target on the
// left edge). The evaluator iterates every connected input and
// concatenates their entity lists; unconnected sockets are skipped, so
// partial wiring during authoring doesn't break the merge.
//
// `extraInputs` are stored on the GraphNode and persisted with the
// graph, so each merge node carries its own socket count.
export const sceneMergeNode: NodeDef = {
  id: 'core/scene-merge',
  category: 'Scene',
  inputs: [],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a single scene containing the concatenation of every connected input scene\'s entities, plus carried-through grass / terrain / waterLevel sidecars',
    },
  ],
  extraInputsSpec: {
    type: 'Scene',
    namePrefix: 'scene',
    addLabel: '+ Add scene',
  },
  doc: {
    summary: 'Variadic Scene combiner — concatenate any number of scenes into one.',
    description: `
Starts with NO input sockets. Click the "+ Add scene" button on the
node (or drag a Scene output onto the phantom drop target on the left
edge) to add another input. Each instance carries its own socket count,
persisted with the graph.

Iterates every connected input and concatenates their entity lists into
a single Scene. Unconnected sockets are silently skipped, so partial
wiring during authoring doesn't break the merge.

Also carries through the render-time sidecars that some scenes need —
\`grass\`, \`terrain\`, \`waterLevel\`. Without this propagation, wrapping
a [core/grass](../../core/grass) or
[terrain/renderer](../../terrain/renderer) scene through a merge would
silently drop the field and the renderer would only see the (often
empty) \`entities\` list. \`waterLevel\` takes the MAX across inputs so
the camera "submerges" the moment it falls below the tallest water
surface in the scene.

For exactly two scenes,
[core/merge-scene-entities](../../core/merge-scene-entities) is a
slightly simpler two-socket alternative. For "I want this entity
positioned at N points", use
[core/instance-scene-on-points](../../core/instance-scene-on-points)
instead — that scatters one scene; this combines many.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.5, segments: 24, rings: 12 },
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 180 },
        inputValues: { size: 0.8 },
      });
      // Two flat colours feed two distinct materials so the merged
      // scene reads as "two coloured objects" rather than one washed-out
      // blob. core/material requires a basecolor texture (not optional).
      const colA = addNode(g, 'core/solid-color', {
        id: 'colA',
        position: { x: 0, y: 360 },
        inputValues: { color: [0.85, 0.36, 0.32, 1], resolution: 32 },
      });
      const colB = addNode(g, 'core/solid-color', {
        id: 'colB',
        position: { x: 0, y: 540 },
        inputValues: { color: [0.32, 0.62, 0.85, 1], resolution: 32 },
      });
      const matA = addNode(g, 'core/material', {
        id: 'matA',
        position: { x: 280, y: 360 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const matB = addNode(g, 'core/material', {
        id: 'matB',
        position: { x: 280, y: 540 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entA = addNode(g, 'core/scene-entity', {
        id: 'entA',
        position: { x: 560, y: 90 },
        inputValues: {},
      });
      const entB = addNode(g, 'core/scene-entity', {
        id: 'entB',
        position: { x: 560, y: 360 },
        inputValues: {},
      });
      const extras: InputDef[] = [
        { name: 'scene_0', type: 'Scene' },
        { name: 'scene_1', type: 'Scene' },
      ];
      const merge = addNode(g, 'core/scene-merge', {
        id: 'merge',
        position: { x: 840, y: 220 },
        extraInputs: extras,
        inputValues: {},
      });
      addEdge(g, { node: colA.id, socket: 'texture' }, { node: matA.id, socket: 'basecolor' });
      addEdge(g, { node: colB.id, socket: 'texture' }, { node: matB.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entA.id, socket: 'geometry' });
      addEdge(g, { node: matA.id, socket: 'material' }, { node: entA.id, socket: 'material' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entB.id, socket: 'geometry' });
      addEdge(g, { node: matB.id, socket: 'material' }, { node: entB.id, socket: 'material' });
      addEdge(g, { node: entA.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
      addEdge(g, { node: entB.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
      return { graph: g, rootNodeId: 'merge' };
    },
  },
  evaluate(_ctx, inputs): { scene: SceneValue } {
    const entities = [];
    const grass: GrassFieldValue[] = [];
    const terrain: TerrainFieldValue[] = [];
    let waterLevel: number | undefined;
    for (const v of Object.values(inputs)) {
      if (v && typeof v === 'object' && Array.isArray((v as SceneValue).entities)) {
        entities.push(...(v as SceneValue).entities);
        // Carry sidecar render-time recipes through. Without these,
        // wrapping a grass / terrain scene through scene-merge would
        // silently drop the field and the renderer would only see
        // the (often empty) `entities` list.
        const g = (v as SceneValue).grass;
        if (g) grass.push(...g);
        const t = (v as SceneValue).terrain;
        if (t) terrain.push(...t);
        // For waterLevel keep the MAX — the camera should "submerge"
        // the moment it falls below the tallest water surface in the
        // scene.
        const wl = (v as SceneValue).waterLevel;
        if (typeof wl === 'number') {
          waterLevel = waterLevel === undefined ? wl : Math.max(waterLevel, wl);
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
