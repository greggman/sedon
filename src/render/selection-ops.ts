// Combinator operations on selection masks: invert + element-wise
// combine (AND / OR / XOR / SUBTRACT). Pure functions on Uint8Array
// — no mesh shape dependency beyond the array length. Edge-selection
// invariants (both twins marked) are caller-preserving: invert flips
// every byte including twin pairs, combine reads/writes byte-wise.
// If both inputs respect the both-twins invariant, the output does
// too.

import type { CpuMeshRef, MeshSelection } from '../core/resources.js';

export type ElementType = 'edges' | 'vertices' | 'faces';

/**
 * Element count for a given type on a mesh — used to size the
 * output mask of `invertSelectionMask` when the input slot is
 * absent (a missing selection is treated as "everything
 * unselected"; inverting that means "everything selected" and we
 * need the full element count to populate the mask).
 */
export function elementCountFor(mesh: CpuMeshRef, type: ElementType): number {
  switch (type) {
    case 'edges':    return mesh.indices.length;       // 1 byte per half-edge id
    case 'vertices': return (mesh.positions.length / 3) | 0;
    case 'faces':    return (mesh.indices.length / 3) | 0;
  }
}

/**
 * Invert a selection mask of the given element type. When the
 * input mesh has no mask for this type, returns a fully-selected
 * mask. Output length always matches the mesh's current element
 * count for the type.
 *
 * Edge-mask caveat: the per-byte flip preserves the "both twins
 * marked" invariant on INTERIOR edges (a paired 1,1 flips to 0,0
 * and vice versa). Boundary half-edges (twin = -1) end up marked
 * selected after invert even though no logical edge sits at that
 * half-edge. Downstream consumers (bevel / chamfer) skip boundary
 * half-edges automatically so the spurious marks are benign;
 * `countEdges` may over-report by `boundaryHalfEdgeCount / 2` on
 * open meshes after invert. If this matters we can add a "clean
 * boundary marks" pass — track it when it bites.
 */
export function invertSelectionMask(mesh: CpuMeshRef, type: ElementType): Uint8Array {
  const n = elementCountFor(mesh, type);
  const input = mesh.selection?.[type];
  const out = new Uint8Array(n);
  if (!input) {
    out.fill(1);
    return out;
  }
  // Treat positions past `input.length` as 0 (the "absent =
  // unselected" convention used everywhere else in this module) —
  // so inverting them gives 1. This shouldn't happen on a topology-
  // preserving graph but the defensive read keeps `invert` total
  // even when a stale mask sneaks through.
  for (let i = 0; i < n; i++) {
    const v = i < input.length ? input[i]! : 0;
    out[i] = v ? 0 : 1;
  }
  return out;
}

export type CombineMode = 'and' | 'or' | 'xor' | 'subtract';

/**
 * Element-wise combine two selection masks of the same type. Both
 * masks are read against the mesh's CURRENT element count for the
 * type: shorter masks behave as if zero-padded; longer masks have
 * their tail ignored.
 *
 * `subtract` is `a AND NOT b` — "everything in A that isn't in B."
 */
export function combineSelectionMasks(
  mesh: CpuMeshRef,
  a: Uint8Array | undefined,
  b: Uint8Array | undefined,
  mode: CombineMode,
  type: ElementType,
): Uint8Array {
  const n = elementCountFor(mesh, type);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const av = a && i < a.length ? a[i]! : 0;
    const bv = b && i < b.length ? b[i]! : 0;
    let v: number;
    switch (mode) {
      case 'and':      v = av && bv ? 1 : 0; break;
      case 'or':       v = av || bv ? 1 : 0; break;
      case 'xor':      v = (av ^ bv) & 1;    break;
      case 'subtract': v = av && !bv ? 1 : 0; break;
    }
    out[i] = v;
  }
  return out;
}

/**
 * Count of distinct logical edges marked in an edge mask. Bytes
 * are marked one-per-half-edge with both twins of a selected edge
 * carrying 1 — divide by 2 for the user-facing edge count.
 */
export function countEdges(edges: Uint8Array | undefined): number {
  if (!edges) return 0;
  let count = 0;
  for (let i = 0; i < edges.length; i++) count += edges[i]!;
  return count >> 1;
}

/** Count selected vertices in a vertex mask. */
export function countVertices(vertices: Uint8Array | undefined): number {
  if (!vertices) return 0;
  let count = 0;
  for (let i = 0; i < vertices.length; i++) count += vertices[i]!;
  return count;
}

/** Count selected faces in a face mask. */
export function countFaces(faces: Uint8Array | undefined): number {
  if (!faces) return 0;
  let count = 0;
  for (let i = 0; i < faces.length; i++) count += faces[i]!;
  return count;
}

/**
 * Attach a single-element-type mask to a mesh, preserving any other
 * populated selection slots. Always allocates a new MeshSelection
 * object so the upstream mesh isn't mutated.
 */
export function withSelectionMask(
  mesh: CpuMeshRef,
  type: ElementType,
  mask: Uint8Array,
): MeshSelection {
  return { ...(mesh.selection ?? {}), [type]: mask };
}
