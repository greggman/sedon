// Regression: when the user wires an inner-graph node's input to the
// subgraph-input boundary (creating a new boundary input on the fly),
// the new input must carry forward the target socket's effective
// value as its `default`. Without that capture, every parent wrapper
// instance that doesn't explicitly wire the new input either:
//   • silently falls back to the system default for the input's type
//     (white for Color, [0,0,0] for Vec3, …), changing the subgraph's
//     behaviour under wrappers, OR
//   • outright fails to evaluate (no default + not optional = the
//     parent's wrapper node is skipped, taking everything downstream
//     with it).
//
// The user-visible symptom that drove this fix: adding a colour input
// to `oak-leaf` turned every tree that uses it (branch-tree,
// branch-canopy, branch-bush) into white-leaved or completely-broken
// versions, even though the subgraph's standalone preview kept
// showing the original dark green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEdge,
  addNode,
  createGraph,
} from '../../src/core/graph.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import {
  createEmptySubgraph,
  defineSubgraph,
  type SubgraphDef,
} from '../../src/core/subgraph.js';
import { createNodeRegistry } from '../../src/core/node-def.js';
import { useEditorStore } from '../../src/editor/store.js';

// =====================================================================
// Store-level: addSubgraphSocketWithEdge captures the default
// =====================================================================

test('addSubgraphSocketWithEdge with capturedDefault stamps it onto the new InputDef', () => {
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('cap-sg', 'cap sg');
  // colorize.low has a node-def default of [0,0,0,1] (black), but
  // suppose the inner instance has been overridden to dark green:
  const colorize = addNode(sg.graph, 'core/colorize', {
    position: { x: 0, y: 0 },
    inputValues: { low: [0.18, 0.36, 0.16, 1] },
  });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(
    sg.id,
    'input',
    'Color',
    { node: colorize.id, socket: 'low' },
    { capturedDefault: [0.18, 0.36, 0.16, 1] },
  );
  const updated = useEditorStore
    .getState()
    .subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs.length, 1, 'one new input was added');
  assert.deepEqual(
    updated.inputs[0]!.default,
    [0.18, 0.36, 0.16, 1],
    'new InputDef carries the captured default',
  );
});

test('addSubgraphSocketWithEdge WITHOUT capturedDefault leaves the InputDef.default undefined (current default-less behavior)', () => {
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('cap-sg-2', 'cap sg 2');
  const colorize = addNode(sg.graph, 'core/colorize', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  // Caller didn't compute a capture — fall back to default-less entry.
  store.addSubgraphSocketWithEdge(sg.id, 'input', 'Color', {
    node: colorize.id,
    socket: 'low',
  });
  const updated = useEditorStore
    .getState()
    .subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs.length, 1);
  assert.equal(
    updated.inputs[0]!.default,
    undefined,
    'no capture supplied → InputDef has no default',
  );
});

test('addSubgraphSocketWithEdge labels the new socket after the source/target handle by default', () => {
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('label-sg', 'label sg');
  const colorize = addNode(sg.graph, 'core/colorize', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(
    sg.id,
    'input',
    'Color',
    { node: colorize.id, socket: 'low' },
    { preferredLabel: 'low' },
  );
  let updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs[0]!.label, 'low', 'first wire from low → label "low"');

  // Drag a second time from the same socket — same preferred label
  // collides, so the store dedupes with "-2".
  store.addSubgraphSocketWithEdge(
    sg.id,
    'input',
    'Color',
    { node: colorize.id, socket: 'low' },
    { preferredLabel: 'low' },
  );
  updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs[1]!.label, 'low-2', 'second collision dedupes with -2 suffix');

  // And a third — "low-3".
  store.addSubgraphSocketWithEdge(
    sg.id,
    'input',
    'Color',
    { node: colorize.id, socket: 'low' },
    { preferredLabel: 'low' },
  );
  updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs[2]!.label, 'low-3');
});

test('addSubgraphSocketWithEdge with no preferredLabel falls back to "untitled" (old behavior preserved)', () => {
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('label-sg-old', 'label sg old');
  const colorize = addNode(sg.graph, 'core/colorize', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(sg.id, 'input', 'Color', {
    node: colorize.id,
    socket: 'low',
  });
  const updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.inputs[0]!.label, 'untitled');
});

test('addSubgraphSocketWithEdge on the OUTPUT side ignores capturedDefault (output sockets have no default)', () => {
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('cap-sg-3', 'cap sg 3');
  const worley = addNode(sg.graph, 'core/worley', { position: { x: 0, y: 0 } });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  store.addSubgraphSocketWithEdge(
    sg.id,
    'output',
    'Texture2D',
    { node: worley.id, socket: 'cells' },
    { capturedDefault: 'should be ignored' as unknown },
  );
  const updated = useEditorStore
    .getState()
    .subgraphs.find((s) => s.id === sg.id)!;
  assert.equal(updated.outputs.length, 1);
  assert.equal(
    (updated.outputs[0] as { default?: unknown }).default,
    undefined,
    'output sockets never carry a default field',
  );
});

// =====================================================================
// End-to-end: subgraph wrapper with a defaulted input evaluates
// successfully when the parent leaves the input unwired
// =====================================================================

// Minimal stand-in for the user's oak-leaf scenario without dragging
// in any GPU-bound nodes: build a subgraph that exposes a Color input
// and emits the same Color from its output socket. The "boundary
// node" passes the value through, so we can verify the wrapper
// resolved its input correctly by reading the boundary-output
// directly.
function buildPassthroughColorSubgraph(opts: { withDefault: boolean }): SubgraphDef {
  const id = `cap-passthrough-${opts.withDefault ? 'with' : 'without'}`;
  const sg = createEmptySubgraph(id, id);
  // Wire boundary-input.color → boundary-output.color directly. No
  // intermediate nodes needed: the goal is to observe what the
  // wrapper passed in.
  const inputEntry = opts.withDefault
    ? { name: 'color', type: 'Color', default: [0.18, 0.36, 0.16, 1] }
    : { name: 'color', type: 'Color' };
  sg.inputs.push(inputEntry);
  sg.outputs.push({ name: 'color', type: 'Color' });
  addEdge(
    sg.graph,
    { node: sg.inputNodeId, socket: 'color' },
    { node: sg.outputNodeId, socket: 'color' },
  );
  return sg;
}

test('wrapper instance with no edge wired evaluates successfully when the InputDef has a default', async () => {
  const sg = buildPassthroughColorSubgraph({ withDefault: true });
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  // Parent graph: just an instance of the wrapper, NO edge wired.
  const parent = createGraph();
  const wrapper = addNode(parent, `subgraph/${sg.id}`, { position: { x: 0, y: 0 } });

  const result = await evaluateGraph(parent, registry, { rootNodeId: wrapper.id });
  assert.deepEqual(
    result.outputs.color,
    [0.18, 0.36, 0.16, 1],
    'with InputDef.default set, the wrapper evaluates using the default',
  );
});

test('wrapper instance with no edge wired and NO default fails to evaluate (canEvaluate=false → skipped)', async () => {
  const sg = buildPassthroughColorSubgraph({ withDefault: false });
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  const parent = createGraph();
  const wrapper = addNode(parent, `subgraph/${sg.id}`, { position: { x: 0, y: 0 } });

  const result = await evaluateGraph(parent, registry, { rootNodeId: wrapper.id });
  // The wrapper is skipped because `color` has no edge / no
  // inputValue / no default / not optional. Output is the empty
  // bag — exactly the symptom that breaks `branch-tree` etc. in the
  // user's repro.
  assert.deepEqual(
    result.outputs,
    {},
    'wrapper with no default and no wired input gets skipped, producing empty outputs',
  );
});

// =====================================================================
// Full integration: drive the store action, then evaluate a parent
// graph using the (now defaulted) wrapper.
// =====================================================================

test('adding a new input then re-evaluating against the SAME cache picks up the new boundary output (no stale-fp cache hit)', async () => {
  // The user's actual crash: drilling into oak-leaf, wiring colorize.low
  // to a fresh boundary input, eval throws "Cannot convert undefined or
  // null to object" inside Float32Array.set. Root cause: the boundary-
  // input node's fingerprint doesn't depend on the subgraph's input
  // list, so the cache hits the pre-edit entry whose outputs map
  // doesn't include the new socket name → downstream nodes read
  // `undefined` for the new input → Float32Array.set crashes.
  //
  // Fix: the boundary NodeDefs carry the subgraph's `version` so any
  // edit bumps their fingerprint along with the wrapper's.
  const { createEvalCache } = await import('../../src/core/eval-cache.js');

  // Two consecutive snapshots of the same subgraph: v0 has no inputs,
  // v1 (bumped) has one Color input. Same id, same boundary node id,
  // simulating what dispatchProject produces.
  const sgV0: SubgraphDef = {
    id: 'stale-fp',
    label: 'stale fp',
    category: 'test',
    inputs: [],
    outputs: [{ name: 'color', type: 'Color' }],
    graph: createGraph(),
    inputNodeId: 'boundary-in',
    outputNodeId: 'boundary-out',
    version: 0,
  };
  addNode(sgV0.graph, 'subgraph-input/stale-fp', { id: 'boundary-in', position: { x: 0, y: 0 } });
  addNode(sgV0.graph, 'subgraph-output/stale-fp', { id: 'boundary-out', position: { x: 200, y: 0 } });
  // v0's output is unwired — eval returns empty outputs.

  const cache = createEvalCache();
  const registry0 = createNodeRegistry();
  for (const def of defineSubgraph(sgV0, registry0)) registry0.register(def);
  const result0 = await evaluateGraph(sgV0.graph, registry0, {
    rootNodeId: 'boundary-out',
    cache,
  });
  assert.equal(
    (result0.outputs as Record<string, unknown>).color,
    undefined,
    'v0: no input wired anywhere ⇒ output `color` is undefined',
  );

  // v1: add an input `color`, wire boundary-input.color →
  // boundary-output.color. New SubgraphDef object with bumped version.
  const sgV1: SubgraphDef = {
    ...sgV0,
    inputs: [{ name: 'color', type: 'Color', default: [0.18, 0.36, 0.16, 1] }],
    graph: { ...sgV0.graph, edges: [...sgV0.graph.edges] },
    version: 1,
  };
  addEdge(sgV1.graph, { node: 'boundary-in', socket: 'color' }, { node: 'boundary-out', socket: 'color' });

  const registry1 = createNodeRegistry();
  for (const def of defineSubgraph(sgV1, registry1)) registry1.register(def);
  const result1 = await evaluateGraph(sgV1.graph, registry1, {
    rootNodeId: 'boundary-out',
    cache, // <-- SAME cache. This is what makes it a regression test.
  });
  assert.deepEqual(
    result1.outputs.color,
    [0.18, 0.36, 0.16, 1],
    'v1: boundary-input must re-evaluate (not cache-hit on v0\'s entry) and surface the new default',
  );
});

test('editing a wrapper instance\'s inputValue override propagates through the boundary to inner nodes (no stale boundary cache)', async () => {
  // Reproduction of issue (2): in the editor, drill into branch-bush,
  // click the oak-leaf wrapper instance, change its `low` colour. The
  // node UI shows the new colour but downstream nodes inside oak-leaf
  // keep using the old one — the bush doesn't change.
  //
  // Root cause: the wrapper's fp moves on inputValue change (it
  // includes inputValues in `filteredInputValues`), but the wrapper
  // only passes upstream-edge fingerprints into the inner via
  // `subgraphInputFingerprints`. inputValue-only inputs leave no
  // trace in that map, so the boundary-input's fp stays identical
  // round-to-round and the cache returns the previous outputs map
  // (still containing the OLD colour). Fix: hash inputValue-only
  // inputs into upstreamFingerprints so they propagate.
  const { createEvalCache } = await import('../../src/core/eval-cache.js');

  // Build a passthrough subgraph: input.color → output.color, with a
  // default of dark green.
  const sg = buildPassthroughColorSubgraph({ withDefault: true });
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  const cache = createEvalCache();
  const parent = createGraph();
  const wrapper = addNode(parent, `subgraph/${sg.id}`, {
    position: { x: 0, y: 0 },
    inputValues: { color: [1, 0, 0, 1] }, // red override on the wrapper instance
  });

  const r1 = await evaluateGraph(parent, registry, { rootNodeId: wrapper.id, cache });
  assert.deepEqual(
    r1.outputs.color,
    [1, 0, 0, 1],
    'first eval: wrapper inputValue red flows through the boundary',
  );

  // Now mutate the inputValue (the UI does this via setInputValue ⇒
  // dispatch) and re-evaluate against the SAME cache. Without the fix
  // the boundary's fp is unchanged from r1, the cache hits the stale
  // entry (whose outputs map carries red), and downstream nodes see
  // red — but our wrapper now expects blue.
  wrapper.inputValues = { color: [0, 0, 1, 1] };
  const r2 = await evaluateGraph(parent, registry, { rootNodeId: wrapper.id, cache });
  assert.deepEqual(
    r2.outputs.color,
    [0, 0, 1, 1],
    'second eval: changed inputValue must propagate; boundary must NOT cache-hit on r1',
  );
});

test('full flow: store.addSubgraphSocketWithEdge with capturedDefault → wrapper in parent graph evaluates without wiring the new input', async () => {
  // Build a minimal subgraph (no inputs initially) whose only inner
  // node is the boundary-output: we'll wire boundary-input → boundary-
  // output via the store action.
  const store = useEditorStore.getState();
  const sg = createEmptySubgraph('cap-flow', 'cap flow');
  sg.outputs.push({ name: 'color', type: 'Color' });
  useEditorStore.setState({
    subgraphs: [sg],
    currentEditingId: sg.id,
    graph: sg.graph,
  });

  // Drag-from-boundary onto the output-boundary's `color` input,
  // capturing dark green as the default.
  store.addSubgraphSocketWithEdge(
    sg.id,
    'input',
    'Color',
    { node: sg.outputNodeId, socket: 'color' },
    { capturedDefault: [0.18, 0.36, 0.16, 1] },
  );

  // Build a registry that knows about the now-1-input subgraph.
  const updated = useEditorStore.getState().subgraphs.find((s) => s.id === sg.id)!;
  const registry = createNodeRegistry();
  for (const def of defineSubgraph(updated, registry)) registry.register(def);

  // Parent graph: wrapper instance with the new input UNWIRED. This
  // is the exact scenario from the user's branch-tree / branch-canopy
  // bug. With the captured default, the wrapper should evaluate and
  // surface that dark-green value through its `color` output.
  const parent = createGraph();
  const wrapper = addNode(parent, `subgraph/${updated.id}`, { position: { x: 0, y: 0 } });

  const result = await evaluateGraph(parent, registry, { rootNodeId: wrapper.id });
  assert.deepEqual(
    result.outputs.color,
    [0.18, 0.36, 0.16, 1],
    'parent wrapper evaluates with the captured default',
  );
});
