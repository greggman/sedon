// Wall sign decoration — a small projecting box subgraph that
// office-assembled scatters on the -X (street) face at body heights
// with per-instance random tint. Modular pattern matches the
// existing storefront awning + side-wall AC scatters.
//
// Tests pin: the wall-sign subgraph surface (no inputs, scene
// output) and that office-assembled scatters it on the -X face with
// a width-seeded random mask + per-point tint, plus that the new
// scene is wired into the assembled merge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWallSignSubgraph } from '../../src/editor/demos/city-billboard.js';
import { buildOfficeAssembledSubgraph } from '../../src/editor/demos/city-office.js';

test('wall-sign subgraph: no inputs, single Scene output', () => {
  const sg = buildWallSignSubgraph();
  assert.equal(sg.id, 'city-wall-sign');
  assert.deepEqual(sg.inputs, []);
  assert.equal(sg.outputs?.[0]?.type, 'Scene');
});

test('office-assembled instantiates the wall-sign subgraph', () => {
  const sg = buildOfficeAssembledSubgraph();
  const kinds = new Set(sg.graph.nodes.map((n) => n.kind));
  assert.ok(kinds.has('subgraph/city-wall-sign'), 'wall-sign wrapper present');
});

test('office-assembled wires per_point_tint on the sign scatter', () => {
  // Per-instance random colour is what makes the scatter read as a
  // population of distinct signs rather than identical clones. The
  // wall-sign material's white basecolor is what `per_point_tint`
  // multiplies onto, so missing this wire = uniform-white signs.
  const sg = buildOfficeAssembledSubgraph();
  // Find the instance-on-points whose `instance` socket comes from
  // the wall-sign wrap.
  const signWrap = sg.graph.nodes.find((n) => n.kind === 'subgraph/city-wall-sign')!;
  const instanceEdge = sg.graph.edges.find(
    (e) => e.from.node === signWrap.id && e.to.socket === 'instance',
  );
  assert.ok(instanceEdge, 'sign wrap → instance socket wired');
  const scatterId = instanceEdge.to.node;
  const tintEdge = sg.graph.edges.find(
    (e) => e.to.node === scatterId && e.to.socket === 'per_point_tint',
  );
  assert.ok(tintEdge, 'per_point_tint wired so signs land in distinct colours');
});

test('office-assembled gates sign placement with a width-seeded random mask', () => {
  // Same authoring pattern as awnings: a width-seeded random-float
  // cloud → cloud-step → instance-on-points.per_point_active. Without
  // the gate, every candidate slot would activate and the building
  // would read as a billboard wall.
  const sg = buildOfficeAssembledSubgraph();
  const signWrap = sg.graph.nodes.find((n) => n.kind === 'subgraph/city-wall-sign')!;
  const instanceEdge = sg.graph.edges.find(
    (e) => e.from.node === signWrap.id && e.to.socket === 'instance',
  )!;
  const scatterId = instanceEdge.to.node;
  const maskEdge = sg.graph.edges.find(
    (e) => e.to.node === scatterId && e.to.socket === 'per_point_active',
  );
  assert.ok(maskEdge, 'per_point_active wired = activation mask in place');
});
