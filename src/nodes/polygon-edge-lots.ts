import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue, PolygonValue } from '../core/resources.js';

// Subdivide each polygon edge into LOTS of randomised width — one
// building footprint per lot. Each lot emits position + inward yaw +
// width on parallel clouds so a downstream `iter/for-each-point` can
// instantiate a parametric building sized to fit.
//
// Outputs (all index-aligned):
//   • points  — PointCloud (positions = lot centre on the edge,
//               normals = (0,1,0), tangents = inward direction)
//   • widths  — FloatCloud (per-lot edge-axis extent in metres)
//   • yaws    — FloatCloud (Y-rotation in radians that aligns local
//               +X with the lot's inward direction; feed into a
//               `scene/transform.rotate.y` so a building authored
//               with "facade along local +Z" faces outward)
//
// Width randomisation: each lot picks a value uniform in
// [min_width, max_width], snapped to a multiple of `width_step`. The
// snapping is what keeps the downstream eval cache useful — without
// it, every lot would be a unique width → unique geometry → its own
// GPU draw. Quantised to a small step (default 1 m) we get O(range)
// unique geometries shared across hundreds of lots.
//
// Reproducibility: lot picks are deterministic from `seed` + per-edge
// counter, so a re-eval of the same polygon yields the same lot
// layout.

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

// Tiny deterministic hash → [0, 1). Same xorshift as
// `polyline-points` so seed semantics line up between the two.
function hashedRand(seed: number, counter: number): number {
  let x = (seed * 2654435761 + counter * 1597334677) | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return ((x >>> 0) % 1_000_003) / 1_000_003;
}

export const polygonEdgeLotsNode: NodeDef = {
  id: 'poly/edge-lots',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'polygon whose outer ring is subdivided into lots',
    },
    {
      name: 'min_width',
      type: 'Float',
      default: 14,
      min: 0.01,
      description: 'minimum lot width along the polygon edge, in metres',
    },
    {
      name: 'max_width',
      type: 'Float',
      default: 26,
      min: 0.01,
      description: 'maximum lot width along the polygon edge, in metres. Each lot picks a width uniform in [min_width, max_width], snapped to a `width_step` multiple',
    },
    {
      name: 'width_step',
      type: 'Float',
      default: 1,
      min: 0.01,
      description: 'quantisation step for the random width pick. Keeping this coarse (≥ 1 m) makes the eval cache reuse downstream parametric-building evaluations across lots — without quantisation, every lot would be a unique width and the cache would never hit',
    },
    {
      name: 'corner_clearance',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'minimum gap from each polygon corner before the first lot can start. Set to about `2 × max_building_inward_extent` so a corner lot\'s inward-projecting building doesn\'t poke past the vertex into the perpendicular edge',
    },
    {
      name: 'gap',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'separation between adjacent lots on the same edge, in metres. 1 m reads as a clean alley between buildings',
    },
    {
      name: 'seed',
      type: 'Int',
      default: 0,
      description: 'random seed mixed into the per-lot pick. Same seed + same polygon → same lot layout',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'one point per lot. position = lot centre on the polygon edge, normal = (0,1,0), tangent = inward direction',
    },
    {
      name: 'widths',
      type: 'FloatCloud',
      description: 'per-lot edge-axis extent in metres (same index as `points`). Wire into a `iter/for-each-point` broadcast input so the body sizes its building to the lot',
    },
    {
      name: 'yaws',
      type: 'FloatCloud',
      description: 'per-lot Y-rotation in radians (same index as `points`). After this yaw a building authored with local +X = "edge direction" and local +Z = "outward" faces correctly. Wire into a `math/vec3-from-floats.y` to feed `scene/transform.rotate` inside the per-lot body',
    },
  ],
  doc: {
    summary: 'Subdivide a polygon\'s outer ring into per-lot building footprints with random widths.',
    description: `
For each edge, walks from one corner (offset by \`corner_clearance\`)
to the other, picking a random width uniformly in
[\`min_width\`, \`max_width\`] (snapped to \`width_step\`) until the
remaining space won't fit \`min_width\`. Each lot gets a position
(centre of its slot), an inward-facing tangent, the width it was
assigned, and the yaw rotation that aligns a downstream parametric
building's local axes with the lot's edge.

Pair with [iter/for-each-point](../../iter/for-each-point) for the
canonical "different building per lot" composition: each lot drives
a separate body invocation, and the parametric building scales to
the lot's reserved width. Quantisation via \`width_step\` keeps the
eval cache effective so identical-width lots share geometry.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'poly/aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [120, 120] },
      });
      const lots = addNode(g, 'poly/edge-lots', {
        id: 'lots',
        position: { x: 280, y: 0 },
        inputValues: { min_width: 12, max_width: 26, width_step: 1, corner_clearance: 12, gap: 1, seed: 7 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: lots.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'lots' };
    },
  },
  evaluate(_ctx, inputs): {
    points: PointCloudValue;
    widths: FloatCloudValue;
    yaws: FloatCloudValue;
  } {
    const emptyCloud = { count: 0, values: new Float32Array(0) };
    const empty = {
      points: {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        tangents: new Float32Array(0),
        count: 0,
      },
      widths: emptyCloud,
      yaws: emptyCloud,
    };
    const poly = inputs.polygon as PolygonValue | undefined;
    if (!poly || poly.outer.length < 6) return empty;
    const minWidth = Math.max(0.01, (inputs.min_width as number) ?? 14);
    const rawMax = Math.max(minWidth, (inputs.max_width as number) ?? 26);
    const step = Math.max(0.01, (inputs.width_step as number) ?? 1);
    const cornerClearance = Math.max(0, (inputs.corner_clearance as number) ?? 0);
    const gap = Math.max(0, (inputs.gap as number) ?? 0);
    const seed = ((inputs.seed as number) | 0) || 1;

    // Snap min/max to the quantisation step. The set of legal widths
    // is { ceil(min/step)*step, …, floor(max/step)*step }. If the snap
    // collapses the range to nothing (rare — only when min ≈ max and
    // both straddle a step boundary), bail out with empty.
    const minSnapped = Math.ceil(minWidth / step) * step;
    const maxSnapped = Math.floor(rawMax / step) * step;
    if (maxSnapped < minSnapped) return empty;
    const numSteps = Math.round((maxSnapped - minSnapped) / step) + 1;

    const outer = poly.outer;
    const n = outer.length / 2;

    const positions: number[] = [];
    const tangents: number[] = [];
    const widths: number[] = [];
    const yaws: number[] = [];

    let counter = 0; // bumped per random pick
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const startX = outer[i * 2]!;
      const startZ = outer[i * 2 + 1]!;
      const dx = outer[j * 2]! - startX;
      const dz = outer[j * 2 + 1]! - startZ;
      const edgeLen = len2(dx, dz);
      if (edgeLen < 1e-12) continue;
      const usable = edgeLen - 2 * cornerClearance;
      if (usable <= 0) continue;
      const dxN = dx / edgeLen;
      const dzN = dz / edgeLen;
      // Inward = +90° (CCW) of edge direction in XZ. Matches
      // polygon-perimeter-points' convention.
      const inwardX = -dzN;
      const inwardZ =  dxN;
      // Yaw that rotates local +X to point along (inwardX, 0, inwardZ).
      // Sedon's `rotationY(θ)` (src/render/mat4.ts) maps local +X to
      // world [cos θ, 0, sin θ] — the column-major matrix has
      // `m[0]=c, m[2]=s`, so a vector through the matrix gets +sin in
      // Z, not −sin. (Some conventions use the opposite sign; ours
      // matches a left-handed +Y-up rotation.) We therefore need
      // cos θ = inwardX and sin θ = inwardZ → atan2(inwardZ, inwardX).
      const yaw = Math.atan2(inwardZ, inwardX);

      let cursor = cornerClearance;
      const endOfUsable = cornerClearance + usable;
      while (cursor < endOfUsable - 1e-6) {
        const remaining = endOfUsable - cursor;
        if (remaining < minSnapped) break;
        // Pick a random width in [minSnapped, min(maxSnapped, snapped_remaining)].
        const snappedRemaining = Math.floor(remaining / step) * step;
        const upper = Math.min(maxSnapped, snappedRemaining);
        if (upper < minSnapped) break;
        const stepsAvail = Math.round((upper - minSnapped) / step) + 1;
        const r = hashedRand(seed, counter++);
        const chosenStep = Math.floor(r * stepsAvail) % stepsAvail;
        const chosenWidth = minSnapped + chosenStep * step;
        const arcCentre = cursor + chosenWidth * 0.5;
        positions.push(
          startX + dxN * arcCentre, 0,
          startZ + dzN * arcCentre,
        );
        tangents.push(inwardX, 0, inwardZ);
        widths.push(chosenWidth);
        yaws.push(yaw);
        cursor += chosenWidth + gap;
      }
      // numSteps is used at validation but not in the per-edge loop.
      // Keep referenced so a future tweak doesn't lose track of it.
      void numSteps;
    }

    const count = widths.length;
    if (count === 0) return empty;

    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
    return {
      points: {
        positions: new Float32Array(positions),
        normals,
        tangents: new Float32Array(tangents),
        count,
      },
      widths: { count, values: new Float32Array(widths) },
      yaws: { count, values: new Float32Array(yaws) },
    };
  },
};
