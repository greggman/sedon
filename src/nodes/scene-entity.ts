import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, MaterialValue, SceneValue } from '../core/resources.js';
import { identityTint } from '../core/resources.js';
import { identity } from '../render/mat4.js';

// Promote a (geometry, material) pair into a Scene with a single entity at
// identity transform and identity tint. Downstream instance-scene-on-points
// multiplies that identity by per-point transforms and tints when scattering.
export const sceneEntityNode: NodeDef = {
  id: 'core/scene-entity',
  category: 'Scene',
  // Stamps subgraphPath into entity provenance — output value depends on
  // the calling context, so the cache must key on subgraphPath too.
  provenanceDependent: true,
  inputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'mesh from any geometry-producing node ([core/sphere](../../core/sphere), [core/heightfield-to-mesh](../../core/heightfield-to-mesh), [core/transform](../../core/transform), …)',
    },
    {
      name: 'material',
      type: 'Material',
      description: 'PBR / terrain / water material from [core/material](../../core/material) or one of the terrain-material nodes',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a Scene containing exactly one entity (the geometry + material pair, at identity transform with identity tint). Wire into [core/scene-merge](../../core/scene-merge) to combine with other scenes, or [core/instance-scene-on-points](../../core/instance-scene-on-points) to scatter copies',
    },
  ],
  doc: {
    summary: 'Pair a Geometry and a Material into a renderable Scene with one entity.',
    description: `
The base scene constructor. Takes a mesh and a material, packages them
into a Scene with one entity at identity transform and identity tint.
That Scene is what the renderer actually consumes — everything else
(merge, instance, transform) just edits the entity list, never the
underlying mesh+material handle.

Stamps provenance onto the entity so the editor's GPU picking can route
clicks back to this node (and through any scattering chain). The
\`provenanceDependent\` flag tells the eval cache to key this node's
output on the calling subgraph context — without it, a thumbnail of
the subgraph would poison the cache for the main-scene wrapper.

To combine multiple entities into one scene, use
[core/scene-merge](../../core/scene-merge) (variadic) or
[core/merge-scene-entities](../../core/merge-scene-entities) (two
inputs). To place this entity at many positions, feed the output into
[core/instance-scene-on-points](../../core/instance-scene-on-points).
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      // core/material requires a basecolor texture (not optional). Feed
      // a flat blue via core/solid-color so the sample graph evaluates
      // cleanly out of the box.
      const basecolor = addNode(g, 'core/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 220 },
        inputValues: { color: [0.36, 0.58, 0.85, 1], resolution: 32 },
      });
      const material = addNode(g, 'core/material', {
        id: 'material',
        position: { x: 280, y: 220 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'core/scene-entity', {
        id: 'entity',
        position: { x: 560, y: 110 },
        inputValues: {},
      });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      return { graph: g, rootNodeId: 'entity' };
    },
  },
  evaluate(ctx, inputs): { scene: SceneValue } {
    return {
      scene: {
        entities: [
          {
            geometry: inputs.geometry as GeometryValue,
            material: inputs.material as MaterialValue,
            transform: identity(),
            tint: identityTint(),
            // Provenance for GPU picking. Top-level scene-entity is the
            // canonical "leaf" producer — placements get prepended as
            // distribute ops scatter this entity downstream.
            provenance: {
              originNodeId: ctx.nodeId ?? '<unknown>',
              subgraphPath: (ctx.subgraphPath ?? []).slice(),
              placements: [],
            },
          },
        ],
      },
    };
  },
};
