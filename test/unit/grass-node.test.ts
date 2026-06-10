// geom/grass produces a render-time grass FIELD (not baked entities),
// and that field must survive the two transforms a scene undergoes
// before it reaches the renderer: scene-merge concatenation and the
// eval cache's resource walk. These are CPU-only checks (no GPU); the
// actual compute/indirect rendering is verified in the running app via
// scripts/repro-grass.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grassNode } from '../../src/nodes/grass.js';
import { sceneMergeNode } from '../../src/nodes/scene-merge.js';
import { walkGpuResources, type SceneValue } from '../../src/core/resources.js';

// A fake Texture2DValue whose `.texture` records destroy() calls, so we
// can assert walkGpuResources reaches it.
function fakeTex(id: string) {
  const texture = { id, destroyed: false, destroy() { (texture as { destroyed: boolean }).destroyed = true; } };
  return { value: { texture, format: 'rgba8unorm' as const, width: 4, height: 4 }, texture };
}
type Handle = { id: string; destroyed: boolean; destroy(): void };
const baseInputs = (): { inputs: Record<string, unknown>; handles: Record<string, Handle> } => {
  const density = fakeTex('density');
  const card0 = fakeTex('card0');
  const hf = fakeTex('hf');
  return {
    inputs: {
      heightTexture: hf.value,
      worldSize: [10, 10] as [number, number],
      density: density.value,
      // Multi-fan-in `cards` arrives as an array; tests start with one
      // card by default and append more for the multi-type case.
      cards: [card0.value],
      maxDistance: 40, spacing: 0.4, bladeWidth: 0.3, bladeHeight: 0.6,
      densityScale: 1, maxSlope: 0.6, windStrength: 0.08, windSpeed: 2,
      baseColor: [0.1, 0.3, 0.1, 1], tipColor: [0.4, 0.6, 0.2, 1],
      colorVariation: 0.25, seed: 0,
    },
    handles: { density: density.texture, card0: card0.texture, hf: hf.texture },
  };
};

const texId = (t: unknown): string => (t as { id: string }).id;

test('geom/grass emits a Scene with one grass field and no baked entities', () => {
  const { inputs } = baseInputs();
  const out = grassNode.evaluate({}, inputs) as { scene: SceneValue };
  assert.deepEqual(out.scene.entities, [], 'grass is a recipe, not baked entities');
  assert.equal(out.scene.grass?.length, 1, 'one grass field');
  const f = out.scene.grass![0]!;
  assert.equal(f.cards.length, 1);
  assert.equal(f.maxDistance, 40);
  assert.deepEqual(f.bladeSize, [0.3, 0.6]);
  assert.deepEqual(f.baseColor, [0.1, 0.3, 0.1], 'Color input → rgb only (alpha dropped)');
});

test('geom/grass packs every entry of the multi `cards` array in order', () => {
  const { inputs } = baseInputs();
  // Append two more cards to the array — edge-creation order in real
  // graphs becomes array order here.
  (inputs.cards as unknown[]).push(fakeTex('card1').value);
  (inputs.cards as unknown[]).push(fakeTex('card2').value);
  const out = grassNode.evaluate({}, inputs) as { scene: SceneValue };
  const f = out.scene.grass![0]!;
  assert.equal(f.cards.length, 3, 'three types');
  assert.equal(texId(f.cards[0]!.texture), 'card0');
  assert.equal(texId(f.cards[1]!.texture), 'card1');
  assert.equal(texId(f.cards[2]!.texture), 'card2');
});

test('geom/grass with missing essential inputs emits an empty scene (partial-wiring safe)', () => {
  // `cards` is now multi-fan-in — "missing" means an empty array
  // rather than a deleted key. Test all three failure modes here.
  for (const drop of ['heightTexture', 'density', 'cards']) {
    const { inputs } = baseInputs();
    if (drop === 'cards') inputs.cards = [];
    else delete inputs[drop];
    const out = grassNode.evaluate({}, inputs) as { scene: SceneValue };
    assert.deepEqual(out.scene.entities, [], `missing ${drop} → empty`);
    assert.equal(out.scene.grass, undefined, `missing ${drop} → no grass field`);
  }
});

test('typeMap is attached only when wired', () => {
  const { inputs } = baseInputs();
  let out = grassNode.evaluate({}, inputs) as { scene: SceneValue };
  assert.equal(out.scene.grass![0]!.typeMap, undefined, 'no typeMap by default');
  inputs.typeMap = fakeTex('type').value;
  out = grassNode.evaluate({}, inputs) as { scene: SceneValue };
  assert.ok(out.scene.grass![0]!.typeMap, 'typeMap attached when wired');
});

test('scene-merge carries grass fields through (terrain + grass → one scene)', () => {
  const grassScene = (grassNode.evaluate({}, baseInputs().inputs) as { scene: SceneValue }).scene;
  const terrainScene: SceneValue = {
    entities: [{ geometry: {} as never, material: {} as never, transform: new Float32Array(16), tint: new Float32Array(4) }],
  };
  // scene/merge is now a single multi-fan-in input named `scenes`;
  // the evaluator receives all wired scenes as an array.
  const merged = sceneMergeNode.evaluate({}, { scenes: [terrainScene, grassScene] }) as { scene: SceneValue };
  assert.equal(merged.scene.entities.length, 1, 'terrain entity preserved');
  assert.equal(merged.scene.grass?.length, 1, 'grass field carried through the merge');
});

test('walkGpuResources reaches every grass texture (so sweepCache keeps them alive)', () => {
  const { inputs, handles } = baseInputs();
  const typeT = fakeTex('typemap');
  handles.typemap = typeT.texture;
  inputs.typeMap = typeT.value;
  const scene = (grassNode.evaluate({}, inputs) as { scene: SceneValue }).scene;
  const visited = new Set<object>();
  walkGpuResources(scene, (r) => visited.add(r as object));
  assert.ok(visited.has(handles.density!), 'density texture walked');
  assert.ok(visited.has(handles.card0!), 'card texture walked');
  assert.ok(visited.has(handles.hf!), 'height texture walked');
  assert.ok(visited.has(handles.typemap!), 'typeMap texture walked');
});
