// Tests for selection combinators: invert + combine (AND/OR/XOR/SUBTRACT).
// Pure ops on Uint8Arrays — the underlying mesh only contributes
// element-count for sizing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CpuMeshRef } from '../../src/core/resources.js';
import {
  combineSelectionMasks,
  countEdges,
  countFaces,
  countVertices,
  elementCountFor,
  invertSelectionMask,
} from '../../src/render/selection-ops.js';

function meshOf(vCount: number, faceCount: number, selection?: CpuMeshRef['selection']): CpuMeshRef {
  return {
    positions: new Float32Array(vCount * 3),
    normals: new Float32Array(vCount * 3),
    uvs: new Float32Array(vCount * 2),
    indices: new Uint32Array(faceCount * 3),
    ...(selection ? { selection } : {}),
  };
}

test('elementCountFor: edges = halfEdgeCount, vertices = vCount, faces = faceCount', () => {
  const m = meshOf(8, 12); // 8 verts, 12 faces (a triangulated cube)
  assert.equal(elementCountFor(m, 'edges'), 36);
  assert.equal(elementCountFor(m, 'vertices'), 8);
  assert.equal(elementCountFor(m, 'faces'), 12);
});

test('invertSelectionMask: absent input → fully-selected output (all 1s)', () => {
  const m = meshOf(4, 2);
  const inv = invertSelectionMask(m, 'edges');
  assert.equal(inv.length, 6);
  for (let i = 0; i < inv.length; i++) assert.equal(inv[i], 1);
});

test('invertSelectionMask: explicit mask flips byte-wise', () => {
  const edges = new Uint8Array([1, 1, 0, 0, 1, 0]);
  const m = meshOf(4, 2, { edges });
  const inv = invertSelectionMask(m, 'edges');
  assert.deepEqual(Array.from(inv), [0, 0, 1, 1, 0, 1]);
});

test('invertSelectionMask: input length shorter than element count is treated as zero-padded', () => {
  // 4 elements declared, but mask only has 2 bytes — the missing tail
  // counts as unselected, so inverting yields all-1.
  const m = meshOf(4, 2, { edges: new Uint8Array([1, 0]) });
  const inv = invertSelectionMask(m, 'edges');
  // 6 half-edge slots (2 faces × 3); first two flip (0, 1), rest are
  // "absent" → 1 in the output.
  assert.deepEqual(Array.from(inv), [0, 1, 1, 1, 1, 1]);
});

test('combineSelectionMasks: AND keeps only bits set in BOTH', () => {
  const m = meshOf(4, 2);
  const a = new Uint8Array([1, 1, 0, 0, 1, 0]);
  const b = new Uint8Array([1, 0, 1, 0, 1, 1]);
  const out = combineSelectionMasks(m, a, b, 'and', 'edges');
  assert.deepEqual(Array.from(out), [1, 0, 0, 0, 1, 0]);
});

test('combineSelectionMasks: OR keeps bits set in EITHER', () => {
  const m = meshOf(4, 2);
  const a = new Uint8Array([1, 1, 0, 0, 1, 0]);
  const b = new Uint8Array([0, 1, 1, 0, 0, 1]);
  const out = combineSelectionMasks(m, a, b, 'or', 'edges');
  assert.deepEqual(Array.from(out), [1, 1, 1, 0, 1, 1]);
});

test('combineSelectionMasks: XOR keeps bits set in exactly one', () => {
  const m = meshOf(4, 2);
  const a = new Uint8Array([1, 1, 0, 0, 1, 0]);
  const b = new Uint8Array([1, 0, 1, 0, 0, 1]);
  const out = combineSelectionMasks(m, a, b, 'xor', 'edges');
  assert.deepEqual(Array.from(out), [0, 1, 1, 0, 1, 1]);
});

test('combineSelectionMasks: SUBTRACT is A AND NOT B', () => {
  const m = meshOf(4, 2);
  const a = new Uint8Array([1, 1, 0, 0, 1, 0]);
  const b = new Uint8Array([1, 0, 1, 0, 0, 1]);
  const out = combineSelectionMasks(m, a, b, 'subtract', 'edges');
  assert.deepEqual(Array.from(out), [0, 1, 0, 0, 1, 0]);
});

test('combineSelectionMasks: undefined operand acts as all-zero', () => {
  const m = meshOf(4, 2);
  const a = new Uint8Array([1, 1, 0, 0, 1, 0]);
  // OR with absent B = A.
  assert.deepEqual(
    Array.from(combineSelectionMasks(m, a, undefined, 'or', 'edges')),
    Array.from(a),
  );
  // AND with absent B = empty.
  assert.deepEqual(
    Array.from(combineSelectionMasks(m, a, undefined, 'and', 'edges')),
    [0, 0, 0, 0, 0, 0],
  );
  // SUBTRACT with absent B = A unchanged ("A and not nothing").
  assert.deepEqual(
    Array.from(combineSelectionMasks(m, a, undefined, 'subtract', 'edges')),
    Array.from(a),
  );
});

test('countEdges: sums bytes and divides by 2 (twin invariant assumption)', () => {
  // 3 logical edges with both-twins-marked = 6 bytes → 3 edges.
  assert.equal(countEdges(new Uint8Array([1, 1, 1, 1, 1, 1])), 3);
  // Empty.
  assert.equal(countEdges(new Uint8Array(6)), 0);
  // Undefined.
  assert.equal(countEdges(undefined), 0);
});

test('countVertices / countFaces: raw sum of bytes (no twin halving)', () => {
  assert.equal(countVertices(new Uint8Array([1, 0, 1, 1, 0])), 3);
  assert.equal(countFaces(new Uint8Array([1, 0, 1, 1, 0])), 3);
  assert.equal(countVertices(undefined), 0);
  assert.equal(countFaces(undefined), 0);
});

test('invertSelectionMask: vertices and faces work the same way (no twin special-case)', () => {
  const m = meshOf(4, 2, {
    vertices: new Uint8Array([1, 0, 1, 0]),
    faces: new Uint8Array([0, 1]),
  });
  assert.deepEqual(Array.from(invertSelectionMask(m, 'vertices')), [0, 1, 0, 1]);
  assert.deepEqual(Array.from(invertSelectionMask(m, 'faces')), [1, 0]);
});
