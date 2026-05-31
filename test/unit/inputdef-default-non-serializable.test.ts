// Guard: `InputDef.default` must hold only JSON-round-trippable values.
//
// Background: the subgraph-input boundary supplies a lazy preview
// Material at eval time (a flat-grey PBR cached per device) so that
// body subgraphs taking a Material as input can preview standalone.
// That value carries a `GPUTexture` handle — fine while it stays as
// a runtime eval output, fatal if it ever leaked into a persisted
// field. `JSON.stringify` of a GPUTexture is `{}`, so the saved
// default would round-trip back as `{texture: {}, …}` — a broken
// material no consumer can render.
//
// `InputDef.default` is the only field where a runtime value could
// realistically end up persisted, and it has exactly two writers:
//   • `addSubgraphSocketWithEdge` (drag-to-create captures a default)
//   • `setSubgraphInputDefault`   (inspector edits a default)
// Both now `throw` on GPU-bearing types so a future code path can't
// silently corrupt a project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNode, createGraph } from '../../src/core/graph.js';
import { useEditorStore } from '../../src/editor/store.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

function seedWithEmptySubgraph(): { sgId: string; consumerNodeId: string } {
  const sgId = 'guard-sg';
  const consumerNodeId = 'consumer';
  const innerGraph = createGraph();
  const inputBoundary = addNode(innerGraph, `subgraph-input/${sgId}`);
  const outputBoundary = addNode(innerGraph, `subgraph-output/${sgId}`);
  const consumer = addNode(innerGraph, 'core/scene-entity', { id: consumerNodeId });
  const sg: SubgraphDef = {
    id: sgId,
    label: 'guard',
    category: 'Subgraphs',
    inputs: [],
    outputs: [],
    graph: innerGraph,
    inputNodeId: inputBoundary.id,
    outputNodeId: outputBoundary.id,
  };
  useEditorStore.setState({
    subgraphs: [sg],
    folders: [],
    currentEditingId: sgId,
    graph: innerGraph,
    undoStack: [],
    redoStack: [],
  });
  return { sgId, consumerNodeId: consumer.id };
}

test('addSubgraphSocketWithEdge throws on Material with a capturedDefault', () => {
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  assert.throws(
    () =>
      useEditorStore.getState().addSubgraphSocketWithEdge(
        sgId,
        'input',
        'Material',
        { node: consumerNodeId, socket: 'material' },
        { capturedDefault: { kind: 'pbr' } as unknown },
      ),
    /cannot store a "Material" value as InputDef\.default/,
  );
});

test('addSubgraphSocketWithEdge throws on Texture2D with a capturedDefault', () => {
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  assert.throws(
    () =>
      useEditorStore.getState().addSubgraphSocketWithEdge(
        sgId,
        'input',
        'Texture2D',
        { node: consumerNodeId, socket: 'basecolor' },
        { capturedDefault: { texture: {}, width: 1 } as unknown },
      ),
    /cannot store a "Texture2D" value as InputDef\.default/,
  );
});

test('addSubgraphSocketWithEdge accepts a Material without a capturedDefault (output side is unchecked too)', () => {
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  // No capturedDefault → no risky value to persist → no throw.
  // The new socket just gets no default; the boundary's lazy preview
  // material fills in at eval time.
  useEditorStore.getState().addSubgraphSocketWithEdge(
    sgId,
    'input',
    'Material',
    { node: consumerNodeId, socket: 'material' },
  );
  const sg = useEditorStore.getState().subgraphs.find((s) => s.id === sgId)!;
  assert.equal(sg.inputs.length, 1);
  assert.equal(sg.inputs[0]?.default, undefined);
});

test('addSubgraphSocketWithEdge accepts a Vec3 with a capturedDefault (serializable types pass through)', () => {
  // Spot-check: the guard targets GPU types specifically; ordinary
  // value types must still capture their defaults the way the
  // drag-to-create flow always has.
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  useEditorStore.getState().addSubgraphSocketWithEdge(
    sgId,
    'input',
    'Vec3',
    { node: consumerNodeId, socket: 'translate' },
    { capturedDefault: [1, 2, 3] },
  );
  const sg = useEditorStore.getState().subgraphs.find((s) => s.id === sgId)!;
  assert.deepEqual(sg.inputs[0]?.default, [1, 2, 3]);
});

test('setSubgraphInputDefault throws on a Material-typed input', () => {
  // Pre-create a Material input on the subgraph (no default), then
  // try to set one via the inspector path.
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  useEditorStore.getState().addSubgraphSocketWithEdge(
    sgId,
    'input',
    'Material',
    { node: consumerNodeId, socket: 'material' },
  );
  const matInput = useEditorStore.getState().subgraphs.find((s) => s.id === sgId)!.inputs[0]!;
  assert.throws(
    () =>
      useEditorStore.getState().setSubgraphInputDefault(
        sgId,
        matInput.name,
        { kind: 'pbr', basecolor: { texture: {} } } as unknown,
      ),
    /cannot store a "Material" value as InputDef\.default/,
  );
});

test('setSubgraphInputDefault accepts clearing the default (undefined) on a Material input', () => {
  // Clearing isn't a write of a non-serializable value, so it must
  // be allowed — otherwise a user couldn't undo an accidental
  // pre-guard default that landed before this throw existed.
  const { sgId, consumerNodeId } = seedWithEmptySubgraph();
  useEditorStore.getState().addSubgraphSocketWithEdge(
    sgId,
    'input',
    'Material',
    { node: consumerNodeId, socket: 'material' },
  );
  const matInput = useEditorStore.getState().subgraphs.find((s) => s.id === sgId)!.inputs[0]!;
  useEditorStore.getState().setSubgraphInputDefault(sgId, matInput.name, undefined);
  const sg = useEditorStore.getState().subgraphs.find((s) => s.id === sgId)!;
  assert.equal(sg.inputs[0]?.default, undefined);
});
