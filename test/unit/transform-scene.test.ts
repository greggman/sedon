// Pin the core/transform-scene composition rules: identity is a
// no-op, translation moves entity transforms in world space, scale +
// rotate compose in the documented order, and side-band scene
// fields (terrain / grass / water level) pass through unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSceneNode } from '../../src/nodes/transform-scene.js';
import { identity, translation } from '../../src/render/mat4.js';
import type {
  SceneEntity,
  SceneEntityProvenance,
  SceneValue,
  TerrainFieldValue,
} from '../../src/core/resources.js';

function fakeEntity(transform: Float32Array): SceneEntity {
  return {
    // The node only reads `transform`; everything else can be a stub
    // for our purposes — we never feed this scene to the renderer.
    geometry: {} as unknown as SceneEntity['geometry'],
    material: {} as unknown as SceneEntity['material'],
    transform,
    tint: new Float32Array([1, 1, 1, 1]),
  };
}

function makeScene(transforms: Float32Array[]): SceneValue {
  return { entities: transforms.map((t) => fakeEntity(t)) };
}

function near(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) < eps;
}

function assertMatNear(actual: Float32Array, expected: number[], where: string): void {
  for (let i = 0; i < 16; i++) {
    assert.ok(
      near(actual[i]!, expected[i]!),
      `${where}: m[${i}] expected ${expected[i]}, got ${actual[i]}`,
    );
  }
}

test('transform-scene: identity inputs leave every entity transform unchanged', () => {
  const t0 = translation(1, 2, 3);
  const t1 = translation(-4, 5, -6);
  const input = makeScene([t0, t1]);
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [0, 0, 0],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  assert.equal(scene.entities.length, 2);
  assertMatNear(scene.entities[0]!.transform, Array.from(t0), 'entity 0');
  assertMatNear(scene.entities[1]!.transform, Array.from(t1), 'entity 1');
});

test('transform-scene: translate-only on identity entities lands them at the translate', () => {
  const id = identity();
  const input = makeScene([id]);
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [5, 0, -2],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  // Column-major translation lives in m[12], m[13], m[14].
  const m = scene.entities[0]!.transform;
  assert.ok(near(m[12]!, 5));
  assert.ok(near(m[13]!, 0));
  assert.ok(near(m[14]!, -2));
});

test('transform-scene: translate composes with an entity that already has a translation (M * existing)', () => {
  // Entity is already at (10, 0, 0); apply translate (1, 2, 3) on top.
  // newWorld = M_translate(1,2,3) * existing_translation(10,0,0) → (11, 2, 3).
  const existing = translation(10, 0, 0);
  const input = makeScene([existing]);
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [1, 2, 3],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  const m = scene.entities[0]!.transform;
  assert.ok(near(m[12]!, 11), `expected x=11, got ${m[12]}`);
  assert.ok(near(m[13]!, 2),  `expected y=2,  got ${m[13]}`);
  assert.ok(near(m[14]!, 3),  `expected z=3,  got ${m[14]}`);
});

test('transform-scene: scale on identity entities scales the translation column accordingly', () => {
  // Entity at origin (identity), scale = (2, 3, 4), translate = (1, 0, 0).
  // newWorld = T(1,0,0) * Rx(0) * Ry(0) * Rz(0) * S(2,3,4) * I.
  // Since identity has no offset, the translation column ends at (1, 0, 0).
  const input = makeScene([identity()]);
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [1, 0, 0],
    rotate: [0, 0, 0],
    scale: [2, 3, 4],
  }) as { scene: SceneValue };
  const m = scene.entities[0]!.transform;
  // Diagonal carries the scale.
  assert.ok(near(m[0]!,  2));
  assert.ok(near(m[5]!,  3));
  assert.ok(near(m[10]!, 4));
  // Translation column unchanged by the scale of an identity entity.
  assert.ok(near(m[12]!, 1));
  assert.ok(near(m[13]!, 0));
  assert.ok(near(m[14]!, 0));
});

test('transform-scene: 90° Y rotation maps an entity sitting at +X to +Z (rotate around WORLD origin)', () => {
  // Entity translated to (1, 0, 0). Rotate the SCENE around Y by π/2.
  // Sedon's rotationY (mat4.ts) sends (1, 0, 0) → (0, 0, +1) — sign
  // follows the convention in mat4.ts, not "world maths".
  const existing = translation(1, 0, 0);
  const input = makeScene([existing]);
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [0, 0, 0],
    rotate: [0, Math.PI / 2, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  const m = scene.entities[0]!.transform;
  assert.ok(near(m[12]!, 0, 1e-5), `x expected ~0, got ${m[12]}`);
  assert.ok(near(m[13]!, 0));
  assert.ok(near(m[14]!, 1, 1e-5), `z expected ~+1, got ${m[14]}`);
});

test('transform-scene: tint and provenance pass through unchanged (by reference, not by clone)', () => {
  // Reference equality is the contract — the node spreads (...e) so
  // tint and provenance fall through identically. Asserting on
  // reference (not value) catches accidental cloning down the line,
  // which would hurt batching downstream.
  const tint = new Float32Array([0.5, 0.6, 0.7, 0.8]);
  const provenance: SceneEntityProvenance = {
    originNodeId: 'fake',
    subgraphPath: [],
    placements: [],
  };
  const e = fakeEntity(identity());
  e.tint = tint;
  e.provenance = provenance;
  const input: SceneValue = { entities: [e] };
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [1, 2, 3],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  const out = scene.entities[0]!;
  assert.equal(out.tint, tint);
  assert.equal(out.provenance, provenance);
});

test('transform-scene: side-band scene fields (waterLevel, terrain) pass through unchanged', () => {
  // Sentinel object: we don't render this scene, so the renderer-shape
  // contract of TerrainFieldValue doesn't matter — we only care that
  // the reference survives the pass-through.
  const sentinelTerrain = [{ kind: 'sentinel' } as unknown as TerrainFieldValue];
  const input: SceneValue = {
    entities: [fakeEntity(identity())],
    waterLevel: 1.25,
    terrain: sentinelTerrain,
  };
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [10, 0, 0],
    rotate: [0, 0, 0],
    scale: [1, 1, 1],
  }) as { scene: SceneValue };
  assert.equal(scene.waterLevel, 1.25);
  assert.equal(scene.terrain, sentinelTerrain);
});

test('transform-scene: empty scene produces an empty scene', () => {
  const input: SceneValue = { entities: [] };
  const { scene } = transformSceneNode.evaluate({}, {
    scene: input,
    translate: [1, 2, 3],
    rotate: [0.5, 0, 0],
    scale: [2, 2, 2],
  }) as { scene: SceneValue };
  assert.equal(scene.entities.length, 0);
});
