// Tests for the fingerprint-based eval cache. These exercise the cache
// machinery against a small fake registry — we don't need a real GPU
// device because the cache itself is content-addressed independent of
// what the nodes actually produce.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import {
  createEvalCache,
  nodeFingerprint,
  sweepCache,
} from '../../src/core/eval-cache.js';
import { evaluateGraph } from '../../src/core/evaluate.js';
import { createNodeRegistry, type NodeRegistry } from '../../src/core/node-def.js';
import { defineSubgraph, createEmptySubgraph } from '../../src/core/subgraph.js';

// Build a tiny registry: one constant node and one node that records
// every time it evaluates so we can assert "cache hit ⇒ evaluate not
// called."
function buildRegistry(evalCounts: Map<string, number>): NodeRegistry {
  const r = createNodeRegistry();
  r.register({
    id: 'test/const',
    category: 'Test',
    inputs: [{ name: 'value', type: 'Float', default: 0 }],
    outputs: [{ name: 'out', type: 'Float' }],
    evaluate(_ctx, inputs) {
      evalCounts.set('test/const', (evalCounts.get('test/const') ?? 0) + 1);
      return { out: inputs.value };
    },
  });
  r.register({
    id: 'test/double',
    category: 'Test',
    inputs: [{ name: 'in', type: 'Float' }],
    outputs: [{ name: 'out', type: 'Float' }],
    evaluate(_ctx, inputs) {
      evalCounts.set('test/double', (evalCounts.get('test/double') ?? 0) + 1);
      return { out: (inputs.in as number) * 2 };
    },
  });
  return r;
}

test('nodeFingerprint is stable across object identity and key order', () => {
  const a = nodeFingerprint({
    nodeId: 'n1',
    kind: 'test/x',
    inputValues: { a: 1, b: 2 },
    upstreamFingerprints: {},
  });
  // Different key insertion order — should still produce the same fingerprint.
  const obj: Record<string, unknown> = {};
  obj.b = 2;
  obj.a = 1;
  const b = nodeFingerprint({
    nodeId: 'n1',
    kind: 'test/x',
    inputValues: obj,
    upstreamFingerprints: {},
  });
  assert.equal(a, b, 'fingerprint independent of key insertion order');
});

test('nodeFingerprint differs when any ingredient differs', () => {
  const base = nodeFingerprint({
    nodeId: 'n1',
    kind: 'test/x',
    inputValues: { a: 1 },
    upstreamFingerprints: { in: 'abc' },
  });
  assert.notEqual(
    base,
    nodeFingerprint({
      nodeId: 'n1',
      kind: 'test/y',
      inputValues: { a: 1 },
      upstreamFingerprints: { in: 'abc' },
    }),
    'kind changes the fingerprint',
  );
  assert.notEqual(
    base,
    nodeFingerprint({
      nodeId: 'n1',
      kind: 'test/x',
      inputValues: { a: 2 },
      upstreamFingerprints: { in: 'abc' },
    }),
    'inputValues changes the fingerprint',
  );
  assert.notEqual(
    base,
    nodeFingerprint({
      nodeId: 'n1',
      kind: 'test/x',
      inputValues: { a: 1 },
      upstreamFingerprints: { in: 'different' },
    }),
    'upstream fingerprint changes the fingerprint',
  );
  assert.notEqual(
    base,
    nodeFingerprint({
      nodeId: 'n1',
      kind: 'test/x',
      version: 7,
      inputValues: { a: 1 },
      upstreamFingerprints: { in: 'abc' },
    }),
    'version changes the fingerprint',
  );
  assert.notEqual(
    base,
    nodeFingerprint({
      nodeId: 'n2',
      kind: 'test/x',
      inputValues: { a: 1 },
      upstreamFingerprints: { in: 'abc' },
    }),
    'nodeId changes the fingerprint — required so two same-config nodes do not share a cache entry',
  );
});

test('cache hit skips evaluate() entirely on a second pass with same inputs', async () => {
  const counts = new Map<string, number>();
  const registry = buildRegistry(counts);
  const cache = createEvalCache();

  const g = createGraph();
  const c = addNode(g, 'test/const', { inputValues: { value: 5 } });
  const d = addNode(g, 'test/double');
  addEdge(g, { node: c.id, socket: 'out' }, { node: d.id, socket: 'in' });

  await evaluateGraph(g, registry, {
    rootNodeId: d.id,
    cache,
    touched: new Set(),
  });
  await evaluateGraph(g, registry, {
    rootNodeId: d.id,
    cache,
    touched: new Set(),
  });

  assert.equal(counts.get('test/const'), 1, 'const evaluated once, hit cache on pass 2');
  assert.equal(counts.get('test/double'), 1, 'double evaluated once, hit cache on pass 2');
});

test('parallel evaluateGraph calls with the same fingerprint coalesce to one evaluate()', async () => {
  // Regression for a race that caused the bark-texture asset thumbnail's
  // basecolor to silently flip between initial paint and the first
  // octaves change. Two evaluateGraph calls (preview pane + asset
  // thumbnail) both reach the same fingerprint, both miss cache.entries
  // before either has finished, both run evaluate() and overwrite each
  // other's cache entry — orphaning the losing consumer's GPU
  // resources and causing subsequent re-evals to silently switch
  // texture handles.
  //
  // Fix: cache.pending coalesces in-flight evals by fp. Second
  // evaluator joins the first's promise instead of re-running evaluate.
  const counts = new Map<string, number>();
  const registry = buildRegistry(counts);
  // A node whose evaluate yields a microtask before returning, so we
  // can deterministically interleave two parallel evaluateGraph calls.
  registry.register({
    id: 'test/async-double',
    category: 'Test',
    inputs: [{ name: 'in', type: 'Float' }],
    outputs: [{ name: 'out', type: 'Float' }],
    async evaluate(_ctx, inputs) {
      counts.set('test/async-double', (counts.get('test/async-double') ?? 0) + 1);
      // Yield once so a sibling evaluator gets to run its cache check.
      await Promise.resolve();
      return { out: (inputs.in as number) * 2 };
    },
  });
  const cache = createEvalCache();

  const g = createGraph();
  const c = addNode(g, 'test/const', { inputValues: { value: 5 } });
  const d = addNode(g, 'test/async-double');
  addEdge(g, { node: c.id, socket: 'out' }, { node: d.id, socket: 'in' });

  const [r1, r2] = await Promise.all([
    evaluateGraph(g, registry, { rootNodeId: d.id, cache, touched: new Set() }),
    evaluateGraph(g, registry, { rootNodeId: d.id, cache, touched: new Set() }),
  ]);

  assert.equal(
    counts.get('test/async-double'),
    1,
    'async-double evaluated exactly once — the second call joined the first via cache.pending',
  );
  // Both consumers see the same output identity (the literal result
  // object returned by the single evaluate() call).
  assert.equal(r1.outputs.out, r2.outputs.out);
  // After both finish, pending is cleared so future evals start fresh.
  assert.equal(cache.pending.size, 0);
});

test('changing an inputValue invalidates only the downstream chain', async () => {
  const counts = new Map<string, number>();
  const registry = buildRegistry(counts);
  const cache = createEvalCache();

  const g1 = createGraph();
  const c1 = addNode(g1, 'test/const', { inputValues: { value: 5 } });
  const d1 = addNode(g1, 'test/double');
  addEdge(g1, { node: c1.id, socket: 'out' }, { node: d1.id, socket: 'in' });

  await evaluateGraph(g1, registry, { rootNodeId: d1.id, cache, touched: new Set() });

  // Same graph shape, but with the constant's value changed. Both const
  // and double must re-evaluate — the const's value flows into double's
  // input, so double's fingerprint changes too.
  const g2 = createGraph();
  const c2 = addNode(g2, 'test/const', { inputValues: { value: 7 } });
  const d2 = addNode(g2, 'test/double');
  addEdge(g2, { node: c2.id, socket: 'out' }, { node: d2.id, socket: 'in' });
  await evaluateGraph(g2, registry, { rootNodeId: d2.id, cache, touched: new Set() });

  assert.equal(counts.get('test/const'), 2);
  assert.equal(counts.get('test/double'), 2);
});

test('subgraph wrapper cache hit skips the entire inner graph', async () => {
  const counts = new Map<string, number>();
  const registry = buildRegistry(counts);
  const cache = createEvalCache();

  // Subgraph: a single output "result" that just doubles a built-in
  // constant. The boundary input has no inputs (we'll make the inner
  // chain self-contained), so the wrapper's inputs are empty.
  const sg = createEmptySubgraph('sg1', 'sg1');
  sg.outputs = [{ name: 'result', type: 'Float' }];
  // sg.version starts undefined ⇒ NodeDef.version = 0
  const constNode = addNode(sg.graph, 'test/const', { inputValues: { value: 3 } });
  const doubleNode = addNode(sg.graph, 'test/double');
  addEdge(
    sg.graph,
    { node: constNode.id, socket: 'out' },
    { node: doubleNode.id, socket: 'in' },
  );
  addEdge(
    sg.graph,
    { node: doubleNode.id, socket: 'out' },
    { node: sg.outputNodeId, socket: 'result' },
  );
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  // Parent graph with one wrapper instance.
  const parent = createGraph();
  const wrapper = addNode(parent, 'subgraph/sg1');

  // First eval: inner const + double both run.
  await evaluateGraph(parent, registry, {
    rootNodeId: wrapper.id,
    cache,
    touched: new Set(),
  });
  assert.equal(counts.get('test/const'), 1, 'inner const evaluated once');
  assert.equal(counts.get('test/double'), 1, 'inner double evaluated once');

  // Second eval: wrapper fingerprint is identical (same kind, same
  // empty inputs, same subgraph version). Cache hit ⇒ wrapper.evaluate
  // is never called, which means evaluateGraph is never called on the
  // inner graph ⇒ counts stay at 1.
  await evaluateGraph(parent, registry, {
    rootNodeId: wrapper.id,
    cache,
    touched: new Set(),
  });
  assert.equal(counts.get('test/const'), 1, 'wrapper cache hit skipped inner const');
  assert.equal(counts.get('test/double'), 1, 'wrapper cache hit skipped inner double');
});

test('bumping subgraph version creates a new wrapper cache entry', async () => {
  // Note about the semantics being tested: bumping the subgraph version
  // ALWAYS forces a wrapper cache miss (its fingerprint changes), so
  // wrapper.evaluate() runs again. BUT individual inner nodes can still
  // cache-hit if their own inputs are unchanged — that's a feature, not
  // a bug. It means editing a comment-only field on a subgraph wrapper
  // costs only the cheap inner cache lookups, not full inner eval.
  // This test asserts the wrapper-level invalidation directly via
  // touched fingerprints.
  const counts = new Map<string, number>();
  const registry = buildRegistry(counts);
  const cache = createEvalCache();

  const sg = createEmptySubgraph('sg-ver', 'sg ver');
  sg.outputs = [{ name: 'result', type: 'Float' }];
  sg.version = 1;
  const c = addNode(sg.graph, 'test/const', { inputValues: { value: 1 } });
  addEdge(
    sg.graph,
    { node: c.id, socket: 'out' },
    { node: sg.outputNodeId, socket: 'result' },
  );
  for (const def of defineSubgraph(sg, registry)) registry.register(def);

  const parent = createGraph();
  const wrapper = addNode(parent, 'subgraph/sg-ver');

  const touched1 = new Set<string>();
  const r1 = await evaluateGraph(parent, registry, {
    rootNodeId: wrapper.id,
    cache,
    touched: touched1,
  });
  const wrapperFp1 = r1.fingerprints.get(wrapper.id)!;
  assert.ok(wrapperFp1);
  assert.ok(touched1.has(wrapperFp1));

  // Bump version, rebuild registry the way the editor would when
  // subgraphs changes ref. Same parent graph, same wrapper instance.
  const registry2 = buildRegistry(counts);
  const sg2 = { ...sg, version: 2 };
  for (const def of defineSubgraph(sg2, registry2)) registry2.register(def);

  const touched2 = new Set<string>();
  const r2 = await evaluateGraph(parent, registry2, {
    rootNodeId: wrapper.id,
    cache,
    touched: touched2,
  });
  const wrapperFp2 = r2.fingerprints.get(wrapper.id)!;
  assert.ok(wrapperFp2);
  assert.notEqual(wrapperFp1, wrapperFp2, 'version bump changes wrapper fingerprint');
  assert.ok(cache.entries.has(wrapperFp1), 'old wrapper entry still present pre-sweep');
  assert.ok(cache.entries.has(wrapperFp2), 'new wrapper entry added');
});

test('changing an inner inputValue forces inner re-eval through a wrapper miss', async () => {
  // This is the path the editor actually walks when a user edits inside
  // a subgraph: routeBack bumps the subgraph version AND the inner
  // graph contains the new inputValues. Both flow into the wrapper's
  // fingerprint (via version) and into the inner const's fingerprint
  // (via the new inputValues) — so both cache-miss and re-eval.
  const counts = new Map<string, number>();
  const registry1 = buildRegistry(counts);
  const cache = createEvalCache();

  const sg = createEmptySubgraph('sg-edit', 'sg edit');
  sg.outputs = [{ name: 'result', type: 'Float' }];
  sg.version = 1;
  const c = addNode(sg.graph, 'test/const', { inputValues: { value: 1 } });
  addEdge(
    sg.graph,
    { node: c.id, socket: 'out' },
    { node: sg.outputNodeId, socket: 'result' },
  );
  for (const def of defineSubgraph(sg, registry1)) registry1.register(def);

  const parent = createGraph();
  const wrapper = addNode(parent, 'subgraph/sg-edit');
  await evaluateGraph(parent, registry1, {
    rootNodeId: wrapper.id,
    cache,
    touched: new Set(),
  });
  assert.equal(counts.get('test/const'), 1);

  // Edit the inner const's value AND bump the version (what the store
  // does on any inner-graph mutation).
  const registry2 = buildRegistry(counts);
  const sgEdited = {
    ...sg,
    version: 2,
    graph: {
      ...sg.graph,
      nodes: sg.graph.nodes.map((n) =>
        n.id === c.id ? { ...n, inputValues: { value: 99 } } : n,
      ),
    },
  };
  for (const def of defineSubgraph(sgEdited, registry2)) registry2.register(def);

  await evaluateGraph(parent, registry2, {
    rootNodeId: wrapper.id,
    cache,
    touched: new Set(),
  });
  assert.equal(counts.get('test/const'), 2, 'changed inner value re-evaluated');
});

test('sweepCache evicts untouched entries and destroys orphan resources', () => {
  const cache = createEvalCache();

  // Fake "GPU texture" — anything with a destroy() method matches the
  // walker's contract.
  let aliveA = true;
  let aliveB = true;
  const texA = { destroy: () => { aliveA = false; } };
  const texB = { destroy: () => { aliveB = false; } };

  // Two entries shaped like Texture2DValue so walkGpuResources finds them.
  cache.entries.set('fpA', {
    out: { texture: texA, format: 'rgba8unorm', width: 1, height: 1 },
  });
  cache.entries.set('fpB', {
    out: { texture: texB, format: 'rgba8unorm', width: 1, height: 1 },
  });

  // Only A was touched this round → B should be evicted and texB destroyed.
  sweepCache(cache, new Set(['fpA']));

  assert.equal(cache.entries.size, 1);
  assert.ok(cache.entries.has('fpA'));
  assert.equal(aliveA, true, 'live entry resource preserved');
  assert.equal(aliveB, false, 'evicted entry resource destroyed');
});

test('ctx.previousOutput carries the prior eval\'s output on a cache miss', async () => {
  // This is the plumbing texture-producing nodes (worley, perlin) rely
  // on to reuse their GPUTexture instead of allocating a fresh one
  // whenever a non-dimension parameter is nudged.
  const seenPrev: Array<unknown> = [];
  const counts = new Map<string, number>();
  const r = buildRegistry(counts);
  // A node that records what `previousOutput` it sees on each call,
  // and produces an output containing a marker so we can verify the
  // value flowing into the next call.
  let nextMarker = 0;
  r.register({
    id: 'test/recorder',
    category: 'Test',
    inputs: [{ name: 'tag', type: 'Float', default: 0 }],
    outputs: [{ name: 'out', type: 'Float' }],
    evaluate(ctx) {
      seenPrev.push(ctx.previousOutput);
      nextMarker += 1;
      return { out: nextMarker };
    },
  });

  const cache = createEvalCache();
  const g = createGraph();
  const node = addNode(g, 'test/recorder', { inputValues: { tag: 1 } });
  await evaluateGraph(g, r, { rootNodeId: node.id, cache, touched: new Set() });

  // Force a fingerprint miss by changing inputValue (the cache works
  // off content; identical re-eval would hit and skip evaluate()).
  const g2 = createGraph();
  g2.nodes.push({ ...node, inputValues: { tag: 2 } });
  await evaluateGraph(g2, r, { rootNodeId: node.id, cache, touched: new Set() });

  assert.equal(seenPrev.length, 2);
  assert.equal(seenPrev[0], undefined, 'first eval has no previous output');
  assert.deepEqual(seenPrev[1], { out: 1 }, 'second eval receives first eval\'s output');
});

test('sweepCache prunes lastFingerprintByNodeId entries whose fp was evicted', () => {
  const cache = createEvalCache();
  cache.entries.set('fpAlive', { out: 1 });
  cache.entries.set('fpDead', { out: 2 });
  cache.lastFingerprintByNodeId.set('nodeAlive', 'fpAlive');
  cache.lastFingerprintByNodeId.set('nodeDead', 'fpDead');

  sweepCache(cache, new Set(['fpAlive']));

  assert.equal(cache.lastFingerprintByNodeId.get('nodeAlive'), 'fpAlive');
  assert.equal(
    cache.lastFingerprintByNodeId.has('nodeDead'),
    false,
    'stale tracker entry pointing at an evicted fp is pruned',
  );
});

test('sweepCache does NOT destroy a resource still referenced by a live entry', () => {
  const cache = createEvalCache();

  let alive = true;
  const sharedTex = { destroy: () => { alive = false; } };
  const t2d = { texture: sharedTex, view: {}, format: 'rgba8unorm', width: 1, height: 1 };

  // "Producer" entry holds the texture directly; "consumer" entry holds
  // a material that references the same texture. Producer gets evicted;
  // consumer survives. The texture must NOT be destroyed because the
  // material in the surviving entry still references it.
  cache.entries.set('producer', { out: t2d });
  cache.entries.set('consumer', {
    out: { kind: 'pbr', basecolor: t2d, roughness: 0.5, metallic: 0 },
  });

  sweepCache(cache, new Set(['consumer']));

  assert.equal(cache.entries.size, 1);
  assert.equal(alive, true, 'shared resource kept alive by surviving entry');
});
