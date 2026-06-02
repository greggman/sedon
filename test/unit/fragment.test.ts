import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEdge, addNode, createGraph } from '../../src/core/graph.js';
import { createEmptySubgraph } from '../../src/core/subgraph.js';
import {
  buildAssetInstancesFragment,
  buildFragment,
  buildSubgraphFragment,
  FRAGMENT_FORMAT_VERSION,
  parseFragment,
  serializeFragment,
} from '../../src/editor/fragment.js';

test('buildFragment returns undefined for empty selection', () => {
  const g = createGraph();
  addNode(g, 'core/perlin');
  const frag = buildFragment(g, new Set(), []);
  assert.equal(frag, undefined);
});

test('buildFragment carries selected nodes and inner edges only', () => {
  // a -> b -> c with `b` also wired to an unselected `d`. Selecting
  // {a, b, c} should keep a→b and b→c, drop b→d.
  const g = createGraph();
  const a = addNode(g, 'core/perlin', { inputValues: { scale: [3, 3] } });
  const b = addNode(g, 'core/blur');
  const c = addNode(g, 'core/levels');
  const d = addNode(g, 'core/colorize');
  addEdge(g, { node: a.id, socket: 'texture' }, { node: b.id, socket: 'texture' });
  addEdge(g, { node: b.id, socket: 'texture' }, { node: c.id, socket: 'texture' });
  addEdge(g, { node: b.id, socket: 'texture' }, { node: d.id, socket: 'factor' });

  const frag = buildFragment(g, new Set([a.id, b.id, c.id]), [])!;
  assert.equal(frag.sedonFragment, FRAGMENT_FORMAT_VERSION);
  assert.equal(frag.nodes.length, 3);
  assert.equal(frag.edges.length, 2, 'b→d dropped (d not in selection)');
  assert.deepEqual(
    frag.nodes.map((n) => n.id).sort(),
    [a.id, b.id, c.id].sort(),
  );
  // Make sure inputValues were carried + deep-cloned (mutating the
  // fragment must not write through to the source graph).
  const aClone = frag.nodes.find((n) => n.id === a.id)!;
  assert.deepEqual(aClone.inputValues, { scale: [3, 3] });
  (aClone.inputValues as Record<string, unknown>).scale = [9, 9];
  assert.deepEqual(a.inputValues, { scale: [3, 3] }, 'source untouched');
});

test('buildFragment pulls in transitively referenced subgraph defs', () => {
  // Project has two subgraphs: `bark-texture` depends on nothing,
  // `tree-canopy` depends on bark-texture (wraps it inside). Selecting
  // a `subgraph/tree-canopy` wrapper in the main graph must produce a
  // fragment that includes BOTH defs.
  const bark = createEmptySubgraph('bark-texture', 'Bark');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  addNode(canopy.graph, 'subgraph/bark-texture');

  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');

  const frag = buildFragment(g, new Set([wrapper.id]), [bark, canopy])!;
  const ids = frag.subgraphs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['bark-texture', 'tree-canopy'].sort());
});

test('buildFragment computes bbox from selected nodes\' positions', () => {
  const g = createGraph();
  const a = addNode(g, 'core/perlin', { position: { x: 10, y: 20 } });
  const b = addNode(g, 'core/blur', { position: { x: 100, y: 200 } });
  const frag = buildFragment(g, new Set([a.id, b.id]), [])!;
  assert.deepEqual(frag.bbox, { x: 10, y: 20, w: 90, h: 180 });
});

test('buildSubgraphFragment captures one def and its deps without root nodes', () => {
  const bark = createEmptySubgraph('bark-texture', 'Bark');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  addNode(canopy.graph, 'subgraph/bark-texture');

  const frag = buildSubgraphFragment('tree-canopy', [bark, canopy])!;
  assert.equal(frag.nodes.length, 0, 'no top-level wrapper instantiated');
  assert.equal(frag.edges.length, 0);
  const ids = frag.subgraphs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['bark-texture', 'tree-canopy'].sort());
});

test('buildSubgraphFragment returns undefined for an unknown def id', () => {
  assert.equal(buildSubgraphFragment('does-not-exist', []), undefined);
});

test('buildAssetInstancesFragment builds wrapper-node instances + dep closure', () => {
  // Two subgraph defs in the project registry, no nesting.
  const a = createEmptySubgraph('asset-a');
  const b = createEmptySubgraph('asset-b');
  const subgraphs = [a, b];
  const frag = buildAssetInstancesFragment(['asset-a', 'asset-b'], subgraphs)!;
  assert.equal(frag.sedonFragment, FRAGMENT_FORMAT_VERSION);
  assert.equal(frag.nodes.length, 2);
  assert.deepEqual(frag.nodes.map((n) => n.kind), ['subgraph/asset-a', 'subgraph/asset-b']);
  // Defs travel along so a paste into a fresh project still works.
  assert.equal(frag.subgraphs.length, 2);
  assert.equal(frag.edges.length, 0);
  // bbox spans the laid-out node row (positions are spaced
  // horizontally so multi-paste doesn't stack on a single point).
  assert.ok(frag.bbox.w > 0);
});

test('buildAssetInstancesFragment drops unknown ids', () => {
  const a = createEmptySubgraph('asset-a');
  const frag = buildAssetInstancesFragment(['asset-a', 'not-real'], [a]);
  assert.ok(frag);
  assert.equal(frag!.nodes.length, 1);
  assert.equal(frag!.nodes[0]!.kind, 'subgraph/asset-a');
});

test('buildAssetInstancesFragment returns undefined when all ids unknown', () => {
  const frag = buildAssetInstancesFragment(['ghost-1', 'ghost-2'], []);
  assert.equal(frag, undefined);
});

test('serialize → parse round-trips a fragment by value', () => {
  const g = createGraph();
  const a = addNode(g, 'core/perlin', { position: { x: 1, y: 2 }, inputValues: { scale: [4, 4] } });
  const b = addNode(g, 'core/blur', { position: { x: 50, y: 60 } });
  addEdge(g, { node: a.id, socket: 'texture' }, { node: b.id, socket: 'texture' });
  const frag = buildFragment(g, new Set([a.id, b.id]), [])!;
  const restored = parseFragment(serializeFragment(frag));
  assert.deepEqual(restored, frag);
});

test('importFragment regenerates node ids — paste-twice produces independent copies', async () => {
  const { importFragment } = await import('../../src/editor/fragment.js');
  const g = createGraph();
  const a = addNode(g, 'core/perlin');
  const b = addNode(g, 'core/blur');
  addEdge(g, { node: a.id, socket: 'texture' }, { node: b.id, socket: 'texture' });
  const frag = buildFragment(g, new Set([a.id, b.id]), [])!;

  const first = importFragment(frag, new Set());
  const second = importFragment(frag, new Set());
  assert.notDeepEqual(
    first.nodes.map((n) => n.id),
    second.nodes.map((n) => n.id),
    'two imports produce disjoint id sets',
  );
  // Edges in the second import must reference the second import's
  // node ids, not the first's.
  const secondIds = new Set(second.nodes.map((n) => n.id));
  for (const e of second.edges) {
    assert.ok(secondIds.has(e.from.node), 'edge from refers to second import\'s nodes');
    assert.ok(secondIds.has(e.to.node), 'edge to refers to second import\'s nodes');
  }
});

test('importFragment renames colliding subgraph defs and rewrites wrapper kinds', async () => {
  const { importFragment } = await import('../../src/editor/fragment.js');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');
  const frag = buildFragment(g, new Set([wrapper.id]), [canopy])!;

  // Target project already has a tree-canopy.
  const imported = importFragment(frag, new Set(['tree-canopy']));
  assert.equal(imported.subgraphs.length, 1);
  assert.equal(imported.subgraphs[0]!.id, 'tree-canopy.1', 'renamed on collision');
  assert.equal(imported.nodes.length, 1);
  assert.equal(
    imported.nodes[0]!.kind,
    'subgraph/tree-canopy.1',
    'wrapper kind rewritten to point at the renamed def',
  );
});

test('importFragment preserves def id when no collision', async () => {
  const { importFragment } = await import('../../src/editor/fragment.js');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');
  const frag = buildFragment(g, new Set([wrapper.id]), [canopy])!;

  const imported = importFragment(frag, new Set()); // empty target — no conflict
  assert.equal(imported.subgraphs[0]!.id, 'tree-canopy');
  assert.equal(imported.nodes[0]!.kind, 'subgraph/tree-canopy');
});

test('importFragment rewires nested wrapper kinds inside renamed defs', async () => {
  // bark and canopy both get renamed (target project has both ids
  // already). The canopy's INNER graph contains a wrapper that points
  // at bark — that inner kind must be rewritten to the new bark id.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const bark = createEmptySubgraph('bark-texture', 'Bark');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  addNode(canopy.graph, 'subgraph/bark-texture');

  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');
  const frag = buildFragment(g, new Set([wrapper.id]), [bark, canopy])!;

  const imported = importFragment(frag, new Set(['bark-texture', 'tree-canopy']));
  const canopyImported = imported.subgraphs.find((s) => s.id === 'tree-canopy.1')!;
  const innerWrappers = canopyImported.graph.nodes.filter((n) => n.kind.startsWith('subgraph/'));
  assert.equal(innerWrappers.length, 1);
  assert.equal(innerWrappers[0]!.kind, 'subgraph/bark-texture.1');
});

test('importFragment with pasteAt centres the bbox at the cursor', async () => {
  const { importFragment } = await import('../../src/editor/fragment.js');
  const g = createGraph();
  addNode(g, 'core/perlin', { position: { x: 100, y: 100 } });
  addNode(g, 'core/blur', { position: { x: 300, y: 300 } });
  const ids = new Set(g.nodes.map((n) => n.id));
  const frag = buildFragment(g, ids, [])!;

  // Source bbox is (100..300, 100..300), centre at (200, 200).
  // Paste at (500, 500) → shift by (+300, +300).
  const imported = importFragment(frag, new Set(), { pasteAt: { x: 500, y: 500 } });
  const xs = imported.nodes.map((n) => n.position?.x).sort();
  const ys = imported.nodes.map((n) => n.position?.y).sort();
  assert.deepEqual(xs, [400, 600]);
  assert.deepEqual(ys, [400, 600]);
});

test('buildSubgraphFragment closure is exactly { root + transitive deps }', () => {
  // A uses B and C. G uses A (inverse direction — must NOT be pulled
  // in). D and F are unrelated. Saving A should yield exactly {A, B, C}.
  const b = createEmptySubgraph('B', 'B');
  const c = createEmptySubgraph('C', 'C');
  const a = createEmptySubgraph('A', 'A');
  addNode(a.graph, 'subgraph/B');
  addNode(a.graph, 'subgraph/C');
  const d = createEmptySubgraph('D', 'D');
  const f = createEmptySubgraph('F', 'F');
  const g = createEmptySubgraph('G', 'G');
  addNode(g.graph, 'subgraph/A'); // inverse dep — uses A, but A doesn't use G

  const frag = buildSubgraphFragment('A', [a, b, c, d, f, g])!;
  const ids = frag.subgraphs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['A', 'B', 'C'], 'D, F (unrelated) and G (inverse) excluded');
  assert.deepEqual(frag.primarySubgraphIds, ['A']);
});

test('importFragment repeated against accumulating project produces A, A.1, A.2', async () => {
  // Save subgraph A, then import it three times against a target that
  // already has A. After each import, the new def id is added to the
  // existing-id set for the next round — mirrors what the editor does
  // when each paste lands in the store.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const a = createEmptySubgraph('A', 'A');
  const frag = buildSubgraphFragment('A', [a])!;

  const existing = new Set<string>(['A']); // target already has A
  const landedIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const imported = importFragment(frag, existing); // default mode rename-all
    assert.equal(imported.subgraphs.length, 1);
    const id = imported.subgraphs[0]!.id;
    landedIds.push(id);
    existing.add(id);
  }
  assert.deepEqual(landedIds, ['A.1', 'A.2', 'A.3']);
});

test('importFragment reuse-deps skips colliding defs and leaves wrapper kinds alone', async () => {
  // Canvas paste semantic: target already has tree-canopy. The pasted
  // wrapper should bind to the TARGET's existing def — no def in the
  // import payload, kind unchanged.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');
  const frag = buildFragment(g, new Set([wrapper.id]), [canopy])!;

  const imported = importFragment(frag, new Set(['tree-canopy']), { mode: 'reuse-deps' });
  assert.equal(imported.subgraphs.length, 0, 'colliding def skipped (reused from target)');
  assert.equal(imported.nodes.length, 1);
  assert.equal(imported.nodes[0]!.kind, 'subgraph/tree-canopy', 'wrapper kind unchanged');
});

test('importFragment reuse-deps brings in defs that DON\'T collide', async () => {
  // Same mode, but the def doesn't exist in the target — should land
  // under its original id.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const canopy = createEmptySubgraph('tree-canopy', 'Canopy');
  const g = createGraph();
  const wrapper = addNode(g, 'subgraph/tree-canopy');
  const frag = buildFragment(g, new Set([wrapper.id]), [canopy])!;

  const imported = importFragment(frag, new Set(), { mode: 'reuse-deps' });
  assert.equal(imported.subgraphs.length, 1);
  assert.equal(imported.subgraphs[0]!.id, 'tree-canopy');
  assert.equal(imported.nodes[0]!.kind, 'subgraph/tree-canopy');
});

test('importFragment rename-primary renames only primary defs; deps reused on collision', async () => {
  // Save Subgraph A (which uses B) → primary=[A], subgraphs=[A,B].
  // Target already has BOTH A and B. rename-primary should rename A to
  // A.1 but reuse the target's B. The rewritten A.1's inner wrapper
  // must point at the original `subgraph/B` (target's B), NOT B.1.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const b = createEmptySubgraph('B', 'B');
  const a = createEmptySubgraph('A', 'A');
  addNode(a.graph, 'subgraph/B');
  const frag = buildSubgraphFragment('A', [a, b])!;

  const imported = importFragment(frag, new Set(['A', 'B']), { mode: 'rename-primary' });
  const ids = imported.subgraphs.map((s) => s.id).sort();
  assert.deepEqual(ids, ['A.1'], 'B not imported — reused from target');
  const aImported = imported.subgraphs.find((s) => s.id === 'A.1')!;
  const innerWrapper = aImported.graph.nodes.find((n) => n.kind.startsWith('subgraph/'))!;
  assert.equal(innerWrapper.kind, 'subgraph/B', 'inner wrapper binds to target\'s existing B');
});

test('importFragment rename-primary still renames deps if they collide AND were marked primary', async () => {
  // Edge case: a primary id that happens to collide. (E.g. saving a
  // bare def with no deps — primary is itself.) Confirms the rename
  // path is unambiguously "primary AND collides".
  const { importFragment } = await import('../../src/editor/fragment.js');
  const a = createEmptySubgraph('A', 'A');
  const frag = buildSubgraphFragment('A', [a])!;

  const imported = importFragment(frag, new Set(['A']), { mode: 'rename-primary' });
  assert.equal(imported.subgraphs.length, 1);
  assert.equal(imported.subgraphs[0]!.id, 'A.1');
});

test('buildFragment carries incoming half-cut edges but not outgoing', () => {
  // upstream → mid → downstream, with only `mid` selected. Expect the
  // fragment to carry upstream→mid (incoming half-cut) but NOT
  // mid→downstream (outgoing half-cut).
  const g = createGraph();
  const upstream = addNode(g, 'core/perlin');
  const mid = addNode(g, 'core/blur');
  const downstream = addNode(g, 'core/levels');
  addEdge(g, { node: upstream.id, socket: 'texture' }, { node: mid.id, socket: 'texture' });
  addEdge(g, { node: mid.id, socket: 'texture' }, { node: downstream.id, socket: 'texture' });

  const frag = buildFragment(g, new Set([mid.id]), [])!;
  assert.equal(frag.edges.length, 1, 'only incoming edge survives');
  assert.equal(frag.edges[0]!.from.node, upstream.id, 'edge from = unselected upstream');
  assert.equal(frag.edges[0]!.to.node, mid.id);
});

test('importFragment wires incoming half-cut edges to destination\'s existing upstream', async () => {
  // Same-graph paste: copy just `mid`. After pasting back into the
  // same graph, the duplicated `mid` should still be wired to
  // `upstream` (existing in the destination).
  const { importFragment } = await import('../../src/editor/fragment.js');
  const g = createGraph();
  const upstream = addNode(g, 'core/perlin');
  const mid = addNode(g, 'core/blur');
  addEdge(g, { node: upstream.id, socket: 'texture' }, { node: mid.id, socket: 'texture' });
  const frag = buildFragment(g, new Set([mid.id]), [])!;

  const existingNodeIds = new Set(g.nodes.map((n) => n.id));
  const imported = importFragment(frag, new Set(), { existingNodeIds });
  assert.equal(imported.edges.length, 1, 'incoming half-cut edge wired up');
  assert.equal(imported.edges[0]!.from.node, upstream.id, 'from = destination\'s existing upstream');
  // to.node should be the REMAPPED mid id (fresh uuid), not the original.
  assert.equal(imported.nodes.length, 1);
  assert.equal(imported.edges[0]!.to.node, imported.nodes[0]!.id);
  assert.notEqual(imported.edges[0]!.to.node, mid.id, 'to = remapped duplicate, not original');
});

test('importFragment drops incoming half-cut edges when upstream is missing in destination', async () => {
  // Cross-graph paste: same fragment, but the destination has no
  // node with the upstream's id. The edge should drop cleanly.
  const { importFragment } = await import('../../src/editor/fragment.js');
  const g = createGraph();
  const upstream = addNode(g, 'core/perlin');
  const mid = addNode(g, 'core/blur');
  addEdge(g, { node: upstream.id, socket: 'texture' }, { node: mid.id, socket: 'texture' });
  const frag = buildFragment(g, new Set([mid.id]), [])!;

  // existingNodeIds omitted → cross-project semantic.
  const imported = importFragment(frag, new Set());
  assert.equal(imported.nodes.length, 1);
  assert.equal(imported.edges.length, 0, 'unresolved half-cut edge dropped');
});

test('parseFragment rejects non-fragment payloads with a useful error', () => {
  assert.throws(
    () => parseFragment('not json at all'),
    /not valid JSON/,
  );
  assert.throws(
    () => parseFragment('"a plain string"'),
    /must be a JSON object/,
  );
  assert.throws(
    () => parseFragment('{}'),
    /not a Sedon fragment/,
  );
  assert.throws(
    () => parseFragment(JSON.stringify({ sedonFragment: 999, nodes: [], edges: [], subgraphs: [], bbox: { x: 0, y: 0, w: 0, h: 0 } })),
    /not a Sedon fragment/,
  );
  assert.throws(
    () => parseFragment(JSON.stringify({ sedonFragment: 1 })),
    /nodes must be an array/,
  );
});
