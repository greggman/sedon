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
  // Minimal Scene emitter for tests that need to verify merge / branch
  // behavior without spinning up a renderer-grade scene-entity chain.
  // `tag` distinguishes one emitter from another in the merged output.
  r.register({
    id: 'test/scene-source',
    category: 'Test',
    inputs: [{ name: 'tag', type: 'Float', default: 0 }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    evaluate: (_ctx, inputs) => ({
      scene: { entities: [{ tag: inputs.tag } as unknown as never] },
    }),
  });
  // Emits `{ color: undefined }` — used to simulate a subgraph
  // wrapper whose declared output socket has no inner wire feeding
  // it (e.g. after the user deletes the only node that was producing
  // the output). The node evaluates fine, it just doesn't materialise
  // a value for that socket.
  r.register({
    id: 'test/empty-color-output',
    category: 'Test',
    inputs: [],
    outputs: [{ name: 'color', type: 'Color' }],
    evaluate: () => ({}),
  });
  return r;
}
