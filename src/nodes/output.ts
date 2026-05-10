import type { NodeDef } from '../core/node-def.js';

// Eval root. Takes a Scene (one or more renderable entities). The preview
// renderer reads scene off the eval result and dispatches one draw call per
// entity. Output exposes scene as a passthrough output so root-extraction
// stays consistent with the rest of the engine.
export const outputNode: NodeDef = {
  id: 'core/output',
  category: 'IO',
  inputs: [{ name: 'scene', type: 'Scene' }],
  outputs: [{ name: 'scene', type: 'Scene' }],
  evaluate(_ctx, inputs) {
    return { scene: inputs.scene };
  },
};
