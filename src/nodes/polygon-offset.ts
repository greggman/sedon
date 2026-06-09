import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PolygonValue } from '../core/resources.js';

// Minkowski-offset a Polygon by a signed distance. Positive `offset`
// dilates outward (every edge moves away from the polygon interior by
// `offset`), negative `offset` shrinks inward.
//
// Algorithm: for each vertex, move it along the angle bisector of its
// two incident edges by an amount that keeps the new edges parallel
// to the originals at the requested distance.
//
//   miter = (n_a + n_b) * offset / (1 + n_a · n_b)
//
// where n_a, n_b are the OUTWARD unit normals of the incoming and
// outgoing edges. (For a CCW polygon viewed from +Y, the outward
// normal of an edge with direction `d = (dx, dz)` is `(dz, -dx)`.)
//
// The formula is the standard miter join. It works correctly for
// convex polygons and for modest insets on simple concave polygons.
// The known limitations — degenerate or self-intersecting output at
// sharp reflex corners, or when `offset` exceeds the polygon's
// inscribed radius — are bounded here by:
//   • A miter LIMIT (default 4×|offset|): cap the bisector length so a
//     ~180° turn doesn't blow up the offset polygon into a spike.
//   • Empty-output sentinel when the resulting ring's signed area
//     flips sign (= the polygon collapsed and self-inverted), so
//     downstream consumers see "no polygon" instead of garbage.
//
// Full Clipper2-style robustness (round / square corner styles,
// polygon clipping during offset to handle full self-intersection)
// is deferred — none of the current city use-cases produce input that
// needs it.

// Rotate (x, z) by 90° CW in XZ. For a CCW polygon (verified by
// polygon-from-points / polygon-aabb), this returns the OUTWARD
// normal of an edge with direction (x, z).
function outwardNormal(dx: number, dz: number): [number, number] {
  return [dz, -dx];
}

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

function signedAreaXZ(packed: Float32Array): number {
  let sum = 0;
  const n = packed.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += packed[i * 2]! * packed[j * 2 + 1]! - packed[j * 2]! * packed[i * 2 + 1]!;
  }
  return sum;
}

// Offset one closed ring. Returns a new Float32Array or null if the
// ring collapsed (signed area flipped or fewer than 3 distinct verts).
export function offsetRing(outer: Float32Array, offset: number, miterLimit = 4): Float32Array | null {
  const n = outer.length / 2;
  if (n < 3) return null;

  // Pre-compute outward unit normals for every edge i → i+1.
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = outer[j * 2]!     - outer[i * 2]!;
    const dz = outer[j * 2 + 1]! - outer[i * 2 + 1]!;
    const L = len2(dx, dz);
    if (L < 1e-12) {
      // Degenerate edge (consecutive duplicate vertex). Use the
      // previous edge's normal so the miter still resolves; if there's
      // no previous either, bail out.
      if (i > 0) { nx[i] = nx[i - 1]!; nz[i] = nz[i - 1]!; }
      else return null;
      continue;
    }
    const [ox, oz] = outwardNormal(dx / L, dz / L);
    nx[i] = ox;
    nz[i] = oz;
  }

  // Miter each vertex: the vertex sits at the intersection of the two
  // edges adjacent to it, which after offset are parallel to the
  // originals at distance `offset` along their outward normals.
  const cap = miterLimit * Math.abs(offset);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n;
    const ax = nx[prev]!, az = nz[prev]!;
    const bx = nx[i]!,    bz = nz[i]!;
    let mx = ax + bx;
    let mz = az + bz;
    // dot(n_a, n_b) ∈ [-1, 1]. = 1 for collinear edges (straight line:
    // miter is exactly n*offset); = -1 for a 180° spike (miter blows
    // up). The denominator `1 + dot` is what produces the divergence
    // at sharp turns.
    const denom = 1 + ax * bx + az * bz;
    let scale: number;
    if (Math.abs(denom) < 1e-6) {
      // Sharp spike or 180° fold. Skip the miter formula and just
      // offset by one of the normals; clamp the miter length to the
      // cap to keep the output bounded.
      mx = bx; mz = bz;
      scale = offset;
    } else {
      scale = offset / denom;
    }
    let mvx = mx * scale;
    let mvz = mz * scale;
    // Miter-length cap. Past this, the bisector would shoot off into
    // a spike on a sharp reflex corner — clip to the cap so the
    // output stays a recognisable polygon.
    const mLen = len2(mvx, mvz);
    if (mLen > cap && cap > 0) {
      mvx = (mvx / mLen) * cap;
      mvz = (mvz / mLen) * cap;
    }
    out[i * 2]     = outer[i * 2]!     + mvx;
    out[i * 2 + 1] = outer[i * 2 + 1]! + mvz;
  }

  // Collapse detection. If the inset went past the polygon's inscribed
  // radius, every vertex crosses through the centre and lands on the
  // far side — producing a "flipped inside-out" polygon. Signed area
  // alone doesn't catch this: the flipped polygon still has positive
  // signed area, just with every edge reversed. So we ALSO check that
  // each new edge points roughly the same direction as its original
  // (positive dot product); if ANY edge has flipped, the polygon has
  // collapsed and we return null.
  const origArea = signedAreaXZ(outer);
  const newArea = signedAreaXZ(out);
  if (origArea === 0 || newArea === 0) return null;
  if (Math.sign(origArea) !== Math.sign(newArea)) return null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const origDx = outer[j * 2]! - outer[i * 2]!;
    const origDz = outer[j * 2 + 1]! - outer[i * 2 + 1]!;
    const newDx  = out[j * 2]!   - out[i * 2]!;
    const newDz  = out[j * 2 + 1]! - out[i * 2 + 1]!;
    if (origDx * newDx + origDz * newDz < 0) return null;
  }
  return out;
}

export const polygonOffsetNode: NodeDef = {
  id: 'core/polygon-offset',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'input polygon (with optional holes — currently ignored, will be supported once concave-hole-aware ear-clipping lands)',
    },
    {
      name: 'offset',
      type: 'Float',
      default: -3,
      description: 'signed distance to move every edge: positive = dilate outward, negative = shrink inward. -3 is a typical sidewalk inset',
    },
    {
      name: 'miter_limit',
      type: 'Float',
      default: 4,
      min: 1,
      description: 'maximum miter length as a multiple of |offset|. Higher → spikier sharp corners; lower → clipped corners',
    },
  ],
  outputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'offset polygon. When the inset exceeds the inscribed radius the polygon collapses; the node then emits an empty polygon (outer.length = 0)',
    },
  ],
  doc: {
    summary: 'Minkowski-offset a polygon (inset / dilate) with miter joins.',
    description: `
Move every edge of the polygon perpendicular to itself by the signed
\`offset\` distance. Positive insets the polygon outward; negative
shrinks it inward. The corners are mitred (sharp).

Use inward (negative) offsets for setbacks — for example, take a
block polygon and inset by 3 m to get the buildable area inside the
sidewalk.

Limitations: a single ring at a time (holes pass through unchanged);
known to degenerate at extreme insets and on sharply reflex corners,
in which case the node emits an empty polygon and downstream consumers
should treat that as "no polygon".
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [40, 60] },
      });
      const inset = addNode(g, 'core/polygon-offset', {
        id: 'inset',
        position: { x: 280, y: 0 },
        inputValues: { offset: -5 },
      });
      const mesh = addNode(g, 'core/polygon-to-mesh', {
        id: 'mesh',
        position: { x: 560, y: 0 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: inset.id, socket: 'polygon' });
      addEdge(g, { node: inset.id, socket: 'polygon' }, { node: mesh.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'mesh' };
    },
  },
  evaluate(_ctx, inputs): { polygon: PolygonValue } {
    const poly = inputs.polygon as PolygonValue;
    const offset = inputs.offset as number;
    const miterLimit = Math.max(1, inputs.miter_limit as number);
    if (!poly || poly.outer.length < 6) {
      return { polygon: { outer: new Float32Array(0) } };
    }
    const outer = offsetRing(poly.outer, offset, miterLimit);
    if (!outer) {
      return { polygon: { outer: new Float32Array(0) } };
    }
    // Holes pass through untouched. Once we support holes in offset
    // they offset INWARD (positive offset shrinks the hole; negative
    // grows it — opposite sign convention because holes are wound
    // opposite to the outer ring).
    if (poly.holes && poly.holes.length > 0) {
      return { polygon: { outer, holes: poly.holes } };
    }
    return { polygon: { outer } };
  },
};
