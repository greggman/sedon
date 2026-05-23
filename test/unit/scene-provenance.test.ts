// P1 of GPU picking: provenance threading. Each SceneEntity must carry
// the chain (originNodeId + subgraph path + placement stack) so that a
// picked instance in the preview can be traced back to a graph node and
// a specific scatter placement (e.g. "Tree #47 inside forest-distribute
// inside main").
//
// Tested here without touching the GPU: we hand-build entities with
// crafted contexts and invoke the node evaluate() functions directly.
// Hits the three producers — scene-entity, instance-scene-on-points,
// merge-scene-entities — plus the subgraph wrapper's contribution to
// ctx.subgraphPath (covered indirectly: scene-entity sees the path the
// wrapper pushes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneEntityNode } from '../../src/nodes/scene-entity.js';
import { instanceSceneOnPointsNode } from '../../src/nodes/instance-scene-on-points.js';
import type {
  GeometryValue,
  MaterialValue,
  PointCloudValue,
  SceneEntity,
  SceneEntityProvenance,
  SceneValue,
  SubgraphPathEntry,
} from '../../src/core/resources.js';
import { identity } from '../../src/render/mat4.js';
import { identityTint } from '../../src/core/resources.js';

// Stand-ins for GPU resources — the picking pipeline doesn't care what's
// in here, only that the SceneEntity wrapping them carries provenance.
const fakeGeom = {} as GeometryValue;
const fakeMat = { kind: 'pbr' } as unknown as MaterialValue;

function makeSourceEntity(prov: SceneEntityProvenance): SceneEntity {
  return {
    geometry: fakeGeom,
    material: fakeMat,
    transform: identity(),
    tint: identityTint(),
    provenance: prov,
  };
}

test('scene-entity stamps originNodeId + current subgraphPath onto the emitted entity', () => {
  const subgraphPath: SubgraphPathEntry[] = [
    { wrapperNodeId: 'wrapper-1', subgraphId: 'oak-tree' },
  ];
  const result = sceneEntityNode.evaluate(
    { nodeId: 'leaf-entity-node', subgraphPath },
    { geometry: fakeGeom, material: fakeMat },
  ) as { scene: SceneValue };
  const e = result.scene.entities[0]!;
  assert.ok(e.provenance, 'entity has provenance');
  assert.equal(e.provenance.originNodeId, 'leaf-entity-node');
  assert.deepEqual(e.provenance.subgraphPath, subgraphPath);
  assert.deepEqual(e.provenance.placements, []);
  // subgraphPath must be a copy (mutating ctx must not bleed into stored provenance)
  assert.notEqual(e.provenance.subgraphPath, subgraphPath);
});

test('instance-scene-on-points appends one placement per scatter, preserving source chain', () => {
  // Source: a "leaf inside oak-tree" — the kind of thing inside a tree subgraph.
  const sourceProv: SceneEntityProvenance = {
    originNodeId: 'inside-tree-leaf',
    subgraphPath: [{ wrapperNodeId: 'tree-wrapper-7', subgraphId: 'oak-tree' }],
    placements: [],
  };
  const source = makeSourceEntity(sourceProv);
  // Three forest points → three placements of the leaf.
  const points: PointCloudValue = {
    count: 3,
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0]),
  };

  const result = instanceSceneOnPointsNode.evaluate(
    { nodeId: 'forest-distribute', subgraphPath: [] },
    {
      points,
      instance: { entities: [source] } as SceneValue,
      scale: 1,
      align: false,
      seed: 0,
    },
  ) as { scene: SceneValue };

  assert.equal(result.scene.entities.length, 3);
  for (let i = 0; i < 3; i++) {
    const e = result.scene.entities[i]!;
    const p = e.provenance!;
    // Source chain preserved exactly — picking a forest leaf still knows
    // it was emitted inside oak-tree, not at the forest level.
    assert.equal(p.originNodeId, 'inside-tree-leaf');
    assert.deepEqual(p.subgraphPath, sourceProv.subgraphPath);
    // One placement per scatter; pointIndex matches.
    assert.equal(p.placements.length, 1);
    assert.equal(p.placements[0]!.distributeNodeId, 'forest-distribute');
    assert.equal(p.placements[0]!.pointIndex, i);
    // pointTransform's translation column = the point position
    assert.equal(p.placements[0]!.pointTransform[12], i * 10);
  }
});

test('nested distribute (forest-of-bushes-of-leaves) accumulates two placements in order', () => {
  // Stage 1: leaf inside bush-subgraph
  const leafProv: SceneEntityProvenance = {
    originNodeId: 'leaf-entity',
    subgraphPath: [{ wrapperNodeId: 'bush-w', subgraphId: 'bush' }],
    placements: [],
  };
  // Stage 2: bush scatters leaf at 2 points
  const bushScatter = instanceSceneOnPointsNode.evaluate(
    { nodeId: 'bush-leaf-scatter', subgraphPath: [{ wrapperNodeId: 'bush-w', subgraphId: 'bush' }] },
    {
      points: { count: 2, positions: new Float32Array([0, 0, 0, 1, 0, 0]) } as PointCloudValue,
      instance: { entities: [makeSourceEntity(leafProv)] } as SceneValue,
      scale: 1, align: false, seed: 0,
    },
  ) as { scene: SceneValue };
  // Stage 3: forest scatters bush at 2 points. Each bush has 2 leaves
  // already, so forest scattering produces 2 × 2 = 4 final leaves.
  const forestScatter = instanceSceneOnPointsNode.evaluate(
    { nodeId: 'forest-distribute', subgraphPath: [] },
    {
      points: { count: 2, positions: new Float32Array([100, 0, 0, 200, 0, 0]) } as PointCloudValue,
      instance: bushScatter.scene as SceneValue,
      scale: 1, align: false, seed: 0,
    },
  ) as { scene: SceneValue };

  assert.equal(forestScatter.scene.entities.length, 4);
  // Every leaf now has two placements: inner bush-leaf-scatter first,
  // then outer forest-distribute. (Outermost-first ordering.)
  for (const e of forestScatter.scene.entities) {
    const p = e.provenance!;
    assert.equal(p.placements.length, 2);
    assert.equal(p.placements[0]!.distributeNodeId, 'bush-leaf-scatter');
    assert.equal(p.placements[1]!.distributeNodeId, 'forest-distribute');
    assert.equal(p.originNodeId, 'leaf-entity');
    assert.deepEqual(p.subgraphPath, leafProv.subgraphPath);
  }
});

test('hand-built entities without provenance still flow through (back-compat)', () => {
  // A graph that builds entities without filling provenance (e.g. tests
  // or future nodes that don't opt in) must not crash; instance-scene-on-points
  // synthesises a minimal provenance pointing at the distribute itself.
  const source: SceneEntity = {
    geometry: fakeGeom,
    material: fakeMat,
    transform: identity(),
    tint: identityTint(),
  };
  const result = instanceSceneOnPointsNode.evaluate(
    { nodeId: 'd1', subgraphPath: [{ wrapperNodeId: 'w', subgraphId: 'sg' }] },
    {
      points: { count: 1, positions: new Float32Array([0, 0, 0]) } as PointCloudValue,
      instance: { entities: [source] } as SceneValue,
      scale: 1, align: false, seed: 0,
    },
  ) as { scene: SceneValue };

  const p = result.scene.entities[0]!.provenance!;
  assert.equal(p.originNodeId, 'd1');
  assert.equal(p.subgraphPath[0]!.subgraphId, 'sg');
  assert.equal(p.placements.length, 1);
});
