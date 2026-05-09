import type { NodeRegistry } from '../../src/core/node-def.js';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';

// Engine tests want a simple "constant emitter" node to verify edge
// propagation, topological order, and the like — without depending on the
// production node set. Production no longer ships a `core/color`, so this
// minimal stand-in lives here.
export function createRegistryForTests(): NodeRegistry {
  const r = createCoreNodeRegistry();
  r.register({
    id: 'test/color-source',
    category: 'Test',
    inputs: [{ name: 'value', type: 'Color', default: [1, 1, 1, 1] }],
    outputs: [{ name: 'color', type: 'Color' }],
    evaluate: (_ctx, inputs) => ({ color: inputs.value }),
  });
  return r;
}
