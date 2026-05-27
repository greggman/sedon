// Tier-1 test: for every registered node kind, mutating any declared
// input must change the node's fingerprint. This is the cheapest
// possible check against "user changed a value but cache returned a
// stale entry" — a class of bug that's bitten us repeatedly (e.g.,
// terrain albedo colours not propagating after a colour-picker edit).
//
// What it covers
//   1. inputValues path — when the UI writes node.inputValues[name],
//      the new value must contribute to the fingerprint hash so the
//      next eval misses the cache and re-runs.
//   2. upstreamFingerprints path — when an upstream node's output
//      changes (its own fp changes), the consumer's fp must change
//      too. (This is essentially testing the fingerprint function's
//      determinism, but cheap and stays honest if anyone refactors
//      the hash.)
//
// What it deliberately does NOT cover
//   - Whether evaluate() actually USES the new value once it re-runs.
//     A separate, more expensive integration test (real WebGPU in
//     puppeteer) is the right tool for that — see the water-v2 repro
//     pattern. Fingerprint testing here is pure logic, runs in
//     <100ms, no GPU needed.
//   - Defaults: when an input is at its default and not present in
//     `node.inputValues`, the runtime currently does NOT mix the
//     default into upstreamFingerprints. That's its own bug class but
//     orthogonal to this test — defaults never change at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreNodeRegistry } from '../../src/nodes/index.js';
import { nodeFingerprint } from '../../src/core/eval-cache.js';
import type { InputDef, NodeDef } from '../../src/core/node-def.js';

const registry = createCoreNodeRegistry();

// Type-aware "give me a clearly different value from `base`". Returns
// undefined for non-primitive types (Texture2D, Heightfield, Scene,
// Material, etc.) because those values flow via upstream connections,
// not inputValues — they're covered by the upstreamFp test below.
function mutatedPrimitive(input: InputDef, base: unknown): unknown {
  switch (input.type) {
    case 'Float':
    case 'Int': {
      const n = typeof base === 'number' ? base : 0;
      // Add 1, but if the input has an enum constraint, pick a
      // different enum value instead so the mutation is still valid.
      if (input.enumOptions && input.enumOptions.length > 1) {
        const other = input.enumOptions.find((o) => o.value !== n);
        return other ? other.value : n + 1;
      }
      return n + 1;
    }
    case 'Bool':
      return !(base === true);
    case 'String':
      return (typeof base === 'string' ? base : '') + '_mutated';
    case 'Vec2':
    case 'Vec3':
    case 'Vec4':
    case 'Color':
    case 'Quaternion': {
      const arr = Array.isArray(base) ? base : [];
      const out = arr.map((v: unknown) => (typeof v === 'number' ? v + 1 : 1));
      // Ensure non-empty so the JSON differs even for missing
      // defaults.
      if (out.length === 0) {
        const len = input.type === 'Vec2' ? 2 : input.type === 'Vec3' ? 3 : 4;
        return new Array(len).fill(1);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function inputValuesFingerprint(def: NodeDef, inputValues: Record<string, unknown>): string {
  return nodeFingerprint({
    nodeId: 'test-node-id',
    kind: def.id,
    inputValues,
    upstreamFingerprints: {},
  });
}

function upstreamFingerprint(def: NodeDef, upstreamFingerprints: Record<string, string>): string {
  return nodeFingerprint({
    nodeId: 'test-node-id',
    kind: def.id,
    inputValues: {},
    upstreamFingerprints,
  });
}

for (const def of registry.list()) {
  for (const input of def.inputs) {
    // ---- inputValues path ----
    const mutated = mutatedPrimitive(input, input.default);
    if (mutated !== undefined) {
      test(`${def.id} :: inputValues[${input.name}] changes fingerprint`, () => {
        const fpDefault = inputValuesFingerprint(def, { [input.name]: input.default });
        const fpMutated = inputValuesFingerprint(def, { [input.name]: mutated });
        assert.notStrictEqual(
          fpDefault,
          fpMutated,
          `${def.id}: changing inputValues[${input.name}] from ${JSON.stringify(input.default)} `
            + `to ${JSON.stringify(mutated)} produced the same fingerprint — `
            + `the cache will return a stale entry`,
        );
      });
    }

    // ---- upstreamFingerprints path ----
    test(`${def.id} :: upstreamFp[${input.name}] changes fingerprint`, () => {
      const fpA = upstreamFingerprint(def, { [input.name]: 'upstream-fp-A' });
      const fpB = upstreamFingerprint(def, { [input.name]: 'upstream-fp-B' });
      assert.notStrictEqual(
        fpA,
        fpB,
        `${def.id}: when input ${input.name} is connected and its upstream fp `
          + `changes, this node's fp must change too`,
      );
    });
  }
}
