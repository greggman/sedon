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
  inputs: [
    { name: 'geometry', type: 'Geometry' },
    { name: 'material', type: 'Material' },
  ],
  outputs: [{ name: 'scene', type: 'Scene' }],
  evaluate(_ctx, inputs): { scene: SceneValue } {
    return {
      scene: {
        entities: [
          {
            geometry: inputs.geometry as GeometryValue,
            material: inputs.material as MaterialValue,
            transform: identity(),
            tint: identityTint(),
          },
        ],
      },
    };
  },
};
