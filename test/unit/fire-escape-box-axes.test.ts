// Regression guard for the wall-scatter box axis convention.
//
// `instance-scene-on-points` with `align: true` on a vertical ±Z
// wall maps the scattered scene's local frame to the wall's TBN
// basis:
//
//   • local +X → tangent  (horizontal ALONG the wall)
//   • local +Y → normal   (OUTWARD from the wall)
//   • local +Z → bitangent (VERTICAL — world up)
//
// `core/box` uses (width = X, height = Y, depth = Z), so any box
// authored for a wall-facade module MUST have:
//
//   • height (Y-extent) = OUTWARD projection (~1.4 m for a fire
//                         escape platform, NOT a 0.12 m vertical
//                         thickness).
//   • depth  (Z-extent) = VERTICAL extent on the wall (the floor
//                         height for a vertical rail, NOT the 0.12 m
//                         outward thickness).
//
// The original fire-escape modules had height ↔ depth swapped, so
// "platforms" rendered as thin tall slabs that didn't read as
// horizontal floors. The user fixed the convention in
// sedon-2026-06-10-04-10-31.sedon; this test pins each module's box
// dimensions so the swap can't silently come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFireEscapeAssembledSubgraph,
  buildFireEscapeBottomModuleSubgraph,
  buildFireEscapeFloorModuleSubgraph,
  buildFireEscapeTopModuleSubgraph,
} from '../../src/editor/demos/city-fire-escape.js';
import { buildWaterTankSubgraph } from '../../src/editor/demos/city-rooftop.js';
import type { GraphNode } from '../../src/core/graph.js';

// Pull all `core/box` instances out of a subgraph, sorted by their
// (width, height, depth) tuple so the test is order-independent.
function boxesIn(nodes: GraphNode[]): { width: number; height: number; depth: number }[] {
  return nodes
    .filter((n) => n.kind === 'core/box')
    .map((n) => {
      const v = n.inputValues as { width: number; height: number; depth: number };
      return { width: v.width, height: v.height, depth: v.depth };
    })
    .sort((a, b) => (
      a.width - b.width
      || a.height - b.height
      || a.depth - b.depth
    ));
}

test('fire-escape-floor: every box has height = OUTWARD and depth = VERTICAL (the wall convention)', () => {
  const sg = buildFireEscapeFloorModuleSubgraph();
  const boxes = boxesIn(sg.graph.nodes);
  assert.equal(boxes.length, 4, 'floor module has 4 boxes (platform + 2 rails + stair stringer)');
  // Expected (sorted): outer rail, frame strut, stair stringer, platform
  assert.deepEqual(boxes, [
    { width: 0.08, height: 0.08, depth: 3.3 },   // outer rail (vertical along Z)
    { width: 0.8,  height: 0.12, depth: 3.7696153649941526 }, // stair stringer (long along Z, rotated)
    { width: 2,    height: 0.08, depth: 3.5 },   // inner frame strut (full floor height vertical)
    { width: 2,    height: 1.4,  depth: 0.12 },  // platform — height=OUTWARD, depth=thin VERTICAL
  ]);
});

test('fire-escape-bottom: 3 boxes — platform + knee rail + 5m drop ladder', () => {
  const sg = buildFireEscapeBottomModuleSubgraph();
  const boxes = boxesIn(sg.graph.nodes);
  assert.deepEqual(boxes, [
    { width: 0.08, height: 0.08, depth: 1 },     // knee rail (1 m vertical)
    { width: 0.4,  height: 0.06, depth: 5 },     // drop ladder (5 m vertical, hangs to ground)
    { width: 2,    height: 1.4,  depth: 0.12 },  // platform
  ]);
});

test('fire-escape-top: 3 boxes — platform + tall rail + 2m roof ladder', () => {
  const sg = buildFireEscapeTopModuleSubgraph();
  const boxes = boxesIn(sg.graph.nodes);
  assert.deepEqual(boxes, [
    { width: 0.08, height: 0.08, depth: 1.2 },   // tall outer rail
    { width: 0.4,  height: 0.06, depth: 2 },     // roof-access ladder
    { width: 2,    height: 1.4,  depth: 0.12 },  // platform
  ]);
});

test('fire-escape-bottom has no parametric inputs (bottom_height was removed)', () => {
  const sg = buildFireEscapeBottomModuleSubgraph();
  assert.deepEqual(sg.inputs, []);
});

test('fire-escape-assembled exposes (num_floors, floor_height, bottom_height, top_height)', () => {
  const sg = buildFireEscapeAssembledSubgraph();
  assert.deepEqual(sg.inputs?.map((i) => i.name), [
    'num_floors', 'floor_height', 'bottom_height', 'top_height',
  ]);
});

test('fire-escape-assembled uses core/add for the top-module Z placement', () => {
  // The .sedon fix swapped a map-range workaround for a real
  // core/add node. If a regression replaces it with a map-range
  // chain again, this test catches it.
  const sg = buildFireEscapeAssembledSubgraph();
  const kinds = new Set(sg.graph.nodes.map((n) => n.kind));
  assert.ok(kinds.has('core/add'), 'expected core/add in fire-escape-assembled');
});

test('water-tank: 4 legs share ONE box geometry via grid-distribute + instance-on-points', () => {
  const sg = buildWaterTankSubgraph();
  const kinds: Record<string, number> = {};
  for (const n of sg.graph.nodes) {
    kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  }
  // The leg cluster uses 1 box + 1 grid-distribute + 1
  // instance-geometry-on-points (was 4 separate boxes).
  assert.equal(kinds['core/box'], 1, 'expected exactly 1 leg box');
  assert.equal(kinds['core/grid-distribute'], 1);
  assert.equal(kinds['core/instance-geometry-on-points'], 1);
});

test('water-tank: body + cap share ONE wood material (was 2 copies)', () => {
  // Exactly two materials total — wood (shared by body + cap) and
  // steel (for the leg cluster).
  const sg = buildWaterTankSubgraph();
  const materials = sg.graph.nodes.filter((n) => n.kind === 'core/material');
  assert.equal(materials.length, 2, 'expected exactly 2 materials (wood + steel)');
});

test('water-tank has 2 cylinders (body + cap), 4 transforms, 3 entities', () => {
  // Pins the topology the user's .sedon fix landed on. Any change
  // to the leg cluster (e.g. reverting to 4 separate boxes) would
  // bump the box count and trip the box test above; this one
  // catches subtler restructurings.
  const sg = buildWaterTankSubgraph();
  const kinds: Record<string, number> = {};
  for (const n of sg.graph.nodes) {
    kinds[n.kind] = (kinds[n.kind] || 0) + 1;
  }
  assert.equal(kinds['core/cylinder'], 2);
  assert.equal(kinds['core/transform-geometry'], 4);
  assert.equal(kinds['core/scene-entity'], 3);
});
