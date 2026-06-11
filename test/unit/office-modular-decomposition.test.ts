// Houdini-style modular decomposition of the parametric office —
// mirrors the fire-escape pattern. Four subgraphs:
//
//   office-ground-floor — 5 m storefront band
//   office-upper-floor  — one 3.5 m floor (instanced N times in the
//                          assembled subgraph)
//   office-roof-cap     — 0.6 m parapet + HVAC + water-tank scatter
//   office-assembled    — composes the three modules + facade
//                          decorations (awnings, side-wall AC, fire
//                          escape)
//
// Tests pin: each module's surface (id, inputs, output type) and that
// the assembled subgraph uses scene/instance-on-points to stack the
// upper-floor module, with a points/line driving the N centres.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOfficeAssembledSubgraph,
  buildOfficeGroundFloorSubgraph,
  buildOfficeRoofCapSubgraph,
  buildOfficeUpperFloorSubgraph,
} from '../../src/editor/demos/city-office.js';

test('office-upper-floor: surface = (width, depth) → scene', () => {
  const sg = buildOfficeUpperFloorSubgraph();
  assert.equal(sg.id, 'office-upper-floor');
  assert.deepEqual(sg.inputs?.map((i) => i.name), ['width', 'depth']);
  assert.equal(sg.outputs?.[0]?.type, 'Scene');
});

test('office-ground-floor: surface = (width, depth) → scene', () => {
  const sg = buildOfficeGroundFloorSubgraph();
  assert.equal(sg.id, 'office-ground-floor');
  assert.deepEqual(sg.inputs?.map((i) => i.name), ['width', 'depth']);
  assert.equal(sg.outputs?.[0]?.type, 'Scene');
});

test('office-roof-cap: surface = (width, depth) → scene', () => {
  const sg = buildOfficeRoofCapSubgraph();
  assert.equal(sg.id, 'office-roof-cap');
  assert.deepEqual(sg.inputs?.map((i) => i.name), ['width', 'depth']);
  assert.equal(sg.outputs?.[0]?.type, 'Scene');
});

test('office-assembled: surface = (width, depth, num_floors, fire_escape_threshold) → scene', () => {
  const sg = buildOfficeAssembledSubgraph();
  assert.equal(sg.id, 'office-assembled');
  assert.deepEqual(
    sg.inputs?.map((i) => i.name),
    ['width', 'depth', 'num_floors', 'fire_escape_threshold'],
  );
  assert.equal(sg.outputs?.[0]?.type, 'Scene');
});

test('office-assembled wires all four modules: ground + upper + roof + fire escape', () => {
  const sg = buildOfficeAssembledSubgraph();
  const kinds = new Set(sg.graph.nodes.map((n) => n.kind));
  assert.ok(kinds.has('subgraph/office-ground-floor'), 'ground-floor wrapper');
  assert.ok(kinds.has('subgraph/office-upper-floor'), 'upper-floor wrapper');
  assert.ok(kinds.has('subgraph/office-roof-cap'), 'roof-cap wrapper');
  assert.ok(kinds.has('subgraph/fire-escape-assembled'), 'fire escape wrapper');
});

test('office-assembled stacks upper-floor module via points/line + scene/instance-on-points', () => {
  // Houdini decomposition: ONE upper-floor module, instanced N times
  // at evenly-spaced Y positions. If a regression replaces the
  // scatter with a hand-stacked sequence of static lifts, this catches
  // it.
  const sg = buildOfficeAssembledSubgraph();
  const kinds = new Set(sg.graph.nodes.map((n) => n.kind));
  assert.ok(kinds.has('points/line'), 'points/line drives N evenly-spaced floor centres');
  assert.ok(kinds.has('scene/instance-on-points'), 'instance-on-points stacks the upper-floor module');
});

test('office-assembled feeds num_floors into points/line.count so the stack height matches the input', () => {
  // The number of stacked floor instances = num_floors. The
  // points/line node's `count` socket must be wired from the
  // subgraph-input.
  const sg = buildOfficeAssembledSubgraph();
  const lineNode = sg.graph.nodes.find((n) => n.kind === 'points/line')!;
  const incomingToCount = sg.graph.edges.find(
    (e) => e.to.node === lineNode.id && e.to.socket === 'count',
  );
  assert.ok(incomingToCount, 'points/line.count must be wired');
  assert.equal(incomingToCount.from.node, sg.inputNodeId, 'wired from subgraph-input');
  assert.equal(incomingToCount.from.socket, 'num_floors');
});

test('office-assembled passes (width-1, depth-1) to the upper-floor wrap (setback)', () => {
  // The body is 0.5 m recessed on every side — same 1-m setback the
  // original parametric office had. Verify the upper-floor wrap's
  // width/depth inputs come through math/add nodes, not directly
  // from the surface inputs.
  const sg = buildOfficeAssembledSubgraph();
  const upperWrap = sg.graph.nodes.find((n) => n.kind === 'subgraph/office-upper-floor')!;
  const widthEdge = sg.graph.edges.find(
    (e) => e.to.node === upperWrap.id && e.to.socket === 'width',
  );
  const depthEdge = sg.graph.edges.find(
    (e) => e.to.node === upperWrap.id && e.to.socket === 'depth',
  );
  assert.ok(widthEdge && depthEdge, 'upper-floor wrap must have width + depth wired');
  // The width edge's source should be a math/add (the setback compute),
  // not the subgraph-input directly.
  const widthSrc = sg.graph.nodes.find((n) => n.id === widthEdge.from.node)!;
  assert.equal(widthSrc.kind, 'math/add', 'setback applied via math/add');
});
