import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import {
  computeGraphAffectedSet,
  computeProjectAffected,
  subgraphHasAnimMap,
} from '../../src/editor/anim-reachability.js';
import type { SubgraphDef } from '../../src/core/subgraph.js';

// Helper: stand-in SubgraphDef for tests. We only care about `id` and
// `graph` for the reachability computation; the rest of the fields
// aren't read.
function sg(id: string, graph: ReturnType<typeof createGraph>): SubgraphDef {
  return {
    id,
    label: id,
    inputs: [],
    outputs: [],
    inputNodeId: '',
    outputNodeId: '',
    graph,
    version: 1,
  } as unknown as SubgraphDef;
}

test('subgraphHasAnimMap: direct anim node flips the flag', () => {
  const g = createGraph();
  addNode(g, 'anim/time', { id: 't' });
  const result = subgraphHasAnimMap([sg('a', g)]);
  assert.equal(result.get('a'), true);
});

test('subgraphHasAnimMap: subgraph without anim stays false', () => {
  const g = createGraph();
  addNode(g, 'tex/grid', { id: 'g' });
  const result = subgraphHasAnimMap([sg('a', g)]);
  assert.equal(result.get('a'), false);
});

test('subgraphHasAnimMap: transitive — wrapper of a hasAnim subgraph flips the outer', () => {
  // Inner subgraph X has anim. Outer subgraph Y wraps X. Y should
  // hasAnim too (fixed-point iteration handles this).
  const innerGraph = createGraph();
  addNode(innerGraph, 'anim/sine', { id: 's' });
  const outerGraph = createGraph();
  addNode(outerGraph, 'subgraph/X', { id: 'w' });
  const map = subgraphHasAnimMap([sg('X', innerGraph), sg('Y', outerGraph)]);
  assert.equal(map.get('X'), true);
  assert.equal(map.get('Y'), true);
});

test('computeGraphAffectedSet: anim node + its single downstream consumer', () => {
  const g = createGraph();
  const a = addNode(g, 'anim/time', { id: 'a' });
  const b = addNode(g, 'math/multiply', { id: 'b' });
  addNode(g, 'math/add', { id: 'c' });
  addEdge(g, { node: a.id, socket: 'time' }, { node: b.id, socket: 'a' });
  // c is NOT downstream of a — should NOT be in affected set.
  const result = computeGraphAffectedSet(g, new Map());
  assert.equal(result.has('a'), true);
  assert.equal(result.has('b'), true);
  assert.equal(result.has('c'), false);
});

test('computeGraphAffectedSet: wrapper of a hasAnim subgraph is a seed', () => {
  // Main graph has a wrapper of subgraph X, where X hasAnim. The
  // wrapper itself is the seed (no anim node in main); downstream of
  // the wrapper is also affected.
  const main = createGraph();
  const w = addNode(main, 'subgraph/X', { id: 'w' });
  const consumer = addNode(main, 'math/multiply', { id: 'c' });
  addEdge(main, { node: w.id, socket: 'out' }, { node: consumer.id, socket: 'a' });
  const subHasAnim = new Map([['X', true]]);
  const result = computeGraphAffectedSet(main, subHasAnim);
  assert.equal(result.has('w'), true);
  assert.equal(result.has('c'), true);
});

test('computeProjectAffected: pure-math project has no affected nodes anywhere', () => {
  const main = createGraph();
  addNode(main, 'math/add', { id: 'a' });
  addNode(main, 'math/multiply', { id: 'b' });
  const { projectHasAnim, perGraphAffected } = computeProjectAffected(main, []);
  assert.equal(projectHasAnim, false);
  assert.equal(perGraphAffected.get('main')!.size, 0);
});

test('iter/* nodes propagate hasAnim via __bridgeId, not via subgraph/ kind', () => {
  // for-each-* nodes own a bridge subgraph referenced by
  // `inputValues.__bridgeId`, not by a `subgraph/` kind prefix. The
  // reachability has to follow that pointer or large city-style
  // graphs (where animation lives several iter-levels deep) end up
  // with no seeds at the iter-containing layers.
  const bodyGraph = createGraph();
  addNode(bodyGraph, 'anim/time', { id: 't' });
  const bridgeGraph = createGraph();
  // Bridge wraps the body via a normal subgraph wrapper.
  addNode(bridgeGraph, 'subgraph/body', { id: 'bWrap' });
  // Main hosts an iter node referencing the bridge by id.
  const main = createGraph();
  const iterNode = addNode(main, 'iter/for-each-point', {
    id: 'iter',
    inputValues: { __bridgeId: 'bridge' },
  });
  const consumer = addNode(main, 'math/multiply', { id: 'c' });
  addEdge(main, { node: iterNode.id, socket: 'out' }, { node: consumer.id, socket: 'a' });

  const { perGraphAffected, subgraphHasAnim } = computeProjectAffected(main, [
    sg('body', bodyGraph),
    sg('bridge', bridgeGraph),
  ]);
  assert.equal(subgraphHasAnim.get('body'), true);
  assert.equal(subgraphHasAnim.get('bridge'), true);
  const mainAff = perGraphAffected.get('main')!;
  assert.ok(mainAff.has('iter'), 'iter node is a seed because its bridge hasAnim');
  assert.ok(mainAff.has('c'), 'downstream of iter is affected');
});

test('computeProjectAffected: anim nested 2 levels deep — main wrapper + its downstream affected', () => {
  // Inner X has anim/lfo
  const innerX = createGraph();
  addNode(innerX, 'anim/lfo', { id: 'l' });
  // Outer Y wraps X
  const outerY = createGraph();
  addNode(outerY, 'subgraph/X', { id: 'wX' });
  // Main wraps Y; downstream of the Y wrapper is "consumer"
  const main = createGraph();
  const wY = addNode(main, 'subgraph/Y', { id: 'wY' });
  const consumer = addNode(main, 'math/multiply', { id: 'c' });
  addNode(main, 'tex/grid', { id: 'u' });
  addEdge(main, { node: wY.id, socket: 'out' }, { node: consumer.id, socket: 'a' });

  const { perGraphAffected, projectHasAnim, subgraphHasAnim } = computeProjectAffected(
    main,
    [sg('X', innerX), sg('Y', outerY)],
  );

  assert.equal(projectHasAnim, true);
  assert.equal(subgraphHasAnim.get('X'), true);
  assert.equal(subgraphHasAnim.get('Y'), true);
  // Main: wY (seed) + c (downstream); u is unrelated.
  const mainAff = perGraphAffected.get('main')!;
  assert.ok(mainAff.has('wY'), 'wY wrapper is a seed');
  assert.ok(mainAff.has('c'), 'consumer downstream of wY is affected');
  assert.ok(!mainAff.has('u'), 'unrelated node is NOT affected');
  // Y: its inner wrapper of X is a seed
  const yAff = perGraphAffected.get('Y')!;
  assert.ok(yAff.has('wX'));
  // X: the anim/lfo node is a seed
  const xAff = perGraphAffected.get('X')!;
  assert.ok(xAff.has('l'));
});
